import fs from "fs";
import path, { dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

import { bcs, BcsType, fromHex, toHex } from "@mysten/bcs";
import init, { get_constants, update_constants, update_identifiers } from "@mysten/move-bytecode-template/move_bytecode_template.js";

import { validateAndNormalizeAddress } from "@polymedia/suitcase-core";
import { log, debug } from "../logger.js";

type TransformConfig = {
    outputDir: string;
    identifiers: Record<string, string>;
    files: {
        bytecodeInputFile: string;
        constants: {
            moveType: string;
            oldVal: unknown;
            newVal: unknown;
        }[];
    }[];
};

export async function bytecodeTransform({
    configFile,
    buildDir,
}:{
    configFile: string;
    buildDir?: string;
}): Promise<void>
{
    await init(loadWasmModule());
    const rawConfig = JSON.parse(fs.readFileSync(configFile, "utf8"));
    const config = validateTransformConfig(rawConfig);

    // build the Move package if requested
    if (buildDir) {
        log("Building Move package...");
        executeBuildCommand(buildDir);
    }

    // ensure output directory exists
    fs.mkdirSync(config.outputDir, { recursive: true });

    // empty .mv files in the output directory
    for (const file of fs.readdirSync(config.outputDir)) {
        if (file.endsWith(".mv")) {
            fs.unlinkSync(path.join(config.outputDir, file));
        }
    }

    // check that all input files exist
    for (const transform of config.files) {
        if (!fs.existsSync(transform.bytecodeInputFile)) {
            throw new Error(`Input file ${transform.bytecodeInputFile} does not exist. Did you forget to \`sui move build\`?`);
        }
    }

    // apply transformations to each bytecode file
    log("Transforming bytecode...");
    for (const transform of config.files) {
        debug(`- ${transform.bytecodeInputFile}`);
        const bytecode = fs.readFileSync(transform.bytecodeInputFile);
        const updatedBytecode = transformBytecode({
            bytecode: new Uint8Array(bytecode),
            identifiers: config.identifiers,
            constants: transform.constants,
        });

        // get the filename from the input path and use it for output
        const outputFile = path.join(config.outputDir, path.basename(transform.bytecodeInputFile));
        fs.writeFileSync(outputFile, updatedBytecode);
    }
    log("Modified bytecode was saved to:", config.outputDir);
}

function loadWasmModule(): Buffer {
    try {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = dirname(__filename);
        const wasmPath = path.resolve(__dirname, "../../node_modules/@mysten/move-bytecode-template/move_bytecode_template_bg.wasm");
        return fs.readFileSync(wasmPath);
    } catch (e) {
        throw new Error(`Failed to load WASM module: ${e}`);
    }
}

function transformBytecode({
    bytecode, identifiers, constants,
}: {
    bytecode: Uint8Array;
    identifiers: Record<string, string>;
    constants: { moveType: string; oldVal: unknown; newVal: unknown }[];
}): Uint8Array
{
    let updated = update_identifiers(bytecode, identifiers);
    for (const constant of constants) {
        const { moveType, oldVal, newVal } = constant;
        if (oldVal === newVal) {
            continue;
        }
        const bcsType = getConstantBcsType(moveType, oldVal);
        const constantsBefore = JSON.stringify(get_constants(updated));
        updated = update_constants(
            updated,
            bcsType.serialize(newVal).toBytes(),
            bcsType.serialize(oldVal).toBytes(),
            moveType,
        );
        if (constantsBefore === JSON.stringify(get_constants(updated))) {
            throw new Error(`Didn't update constant '${moveType}' with value ${oldVal} to ${newVal}. Make sure 'moveType' and 'oldVal' are correct in your config. You may need to \`sui move build\` again.`);
        }
    }

    return updated;
}

/**
 * Get a `BcsType` to serialize/deserialize the value of a constant.
 *
 * Valid constant types:
 * - U8, U16, U32, U64, U128, U256, Bool, Address, Vector(_)
 *
 * Note that Vector(U8) can be an array of numbers or a string.
 *
 * @param moveType - The Move type of the constant, capitalized: U8, Address, Vector(U8), etc.
 * @param value - The value of the constant.
 */
function getConstantBcsType(
    moveType: string,
    value: unknown,
): BcsType<unknown, any>
{
    const type = moveType.trim();

    if (type.startsWith("Vector("))
    {
        const innerType = type.slice(7, -1).trim();

        // Vector(U8) can be an array of numbers or a string
        if (innerType === "U8") {
            if (isStringValue(value)) {
                return bcs.string();
            }
            if (isNumberArray(value)) {
                return bcs.vector(bcs.u8());
            }
            throw new Error(`Invalid value for Vector(U8): ${value}`);
        }

        // regular vector cases
        const innerValue: unknown = (Array.isArray(value) && value.length > 0)
            ? value[0] // take 1st element as sample
            : null;
        return bcs.vector(getConstantBcsType(innerType, innerValue));
    }

    if (type === "Address")
    {
        return bcs.bytes(32).transform({
            input: (val: string) => {
                const normalized = validateAndNormalizeAddress(val);
                if (normalized === null) {
                    throw new Error(`Invalid address: ${val}`);
                }
                return fromHex(normalized);
            },
            output: (val) => toHex(val),
        });
    }

    // base types
    switch (type)
    {
        case "U8": return bcs.u8();
        case "U16": return bcs.u16();
        case "U32": return bcs.u32();
        case "U64": return bcs.u64();
        case "U128": return bcs.u128();
        case "U256": return bcs.u256();
        case "Bool": return bcs.bool();
        default:
            throw new Error(`Unsupported Move type: ${type}`);
    }
}

function validateTransformConfig(config: unknown): TransformConfig
{
    if (!config || typeof config !== "object") {
        throw new Error("Config must be an object");
    }

    const c = config as any;

    if (!c.outputDir || typeof c.outputDir !== "string") {
        throw new Error("Config must have an 'outputDir' string");
    }

    if (!c.identifiers || typeof c.identifiers !== "object") {
        throw new Error("Config must have an 'identifiers' object");
    }

    if (!Array.isArray(c.files)) {
        throw new Error("Config must have a 'files' array");
    }

    for (const file of c.files) {
        if (!file.bytecodeInputFile || typeof file.bytecodeInputFile !== "string") {
            throw new Error("Each file must have a 'bytecodeInputFile' string");
        }
        if (!Array.isArray(file.constants)) {
            throw new Error("Each file must have a 'constants' array");
        }

        for (const constant of file.constants) {
            if (!constant.moveType || typeof constant.moveType !== "string") {
                throw new Error("Each constant must have a 'moveType' string");
            }
            if (!("oldVal" in constant)) {
                throw new Error("Each constant must have an 'oldVal'");
            }
            if (!("newVal" in constant)) {
                throw new Error("Each constant must have a 'newVal'");
            }
        }
    }

    return config as TransformConfig;
}

function executeBuildCommand(buildDir: string): void
{
    const buildCmd = ["sui", "move", "build"];
    buildCmd.push("--path", buildDir);

    if (global.outputJson) {
        buildCmd.push("--json-errors");
    }

    if (global.outputQuiet) {
        buildCmd.push("--silence-warnings");
    }

    debug("Running build command:", buildCmd.join(" "));

    const result = spawnSync(buildCmd[0], buildCmd.slice(1), {
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8"
    });

    // Process build output (from stderr)
    if (result.stderr && !global.outputQuiet) {
        const lines = result.stderr.trim().split("\n");
        for (const line of lines) {
            if (line.trim()) {
                log(line);
            }
        }
    }

    // Check for actual errors via exit code
    if (result.status !== 0) {
        throw new Error(`Build command failed with status ${result.status}`);
    }
}

function isStringValue(val: unknown): boolean {
    return typeof val === "string";
}

function isNumberArray(val: unknown): boolean {
    return Array.isArray(val) && val.every(item => typeof item === "number");
}
