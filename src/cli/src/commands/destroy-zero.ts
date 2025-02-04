import { DevInspectResults, PaginatedObjectsResponse, SuiClient, SuiTransactionBlockResponse } from "@mysten/sui/client";
import { Signer } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";

import { objResToFields } from "@polymedia/suitcase-core";
import { setupSuiTransaction, signAndExecuteTx } from "@polymedia/suitcase-node";

import { debug, log } from "../logger.js";

// "Size limit exceeded: serialized transaction size exceeded maximum of 131072 is ..."
// see `max_tx_size_bytes` in sui/crates/sui-protocol-config/src/lib.rs
const MAX_CALLS_PER_TX = 750;

export async function destroyZero(
    devInspect: boolean,
): Promise<void>
{
    const { signer, client } = await setupSuiTransaction();
    let totalGas = 0;
    let batchNumber = 0;
    let totalBatches = 0;

    async function processBatch(
        coins: {
            objectId: string,
            innerType: string,
        }[],
    )
    {
        batchNumber++;
        const tx = new Transaction();
        for (const coin of coins) {
            tx.moveCall({
                target: "0x2::coin::destroy_zero",
                typeArguments: [coin.innerType],
                arguments: [tx.object(coin.objectId)],
            });
        }
        log(`Sending tx ${batchNumber}/${totalBatches} with ${coins.length} coins...`);
        const resp = await executeTransaction(tx, client, signer, devInspect);

        if (!devInspect && resp.effects?.gasUsed) {
            const gas = resp.effects.gasUsed;
            totalGas += Number(gas.computationCost) + Number(gas.storageCost) - Number(gas.storageRebate);
        }
    }

    let pagObjRes: PaginatedObjectsResponse;
    let cursor: null | string = null;
    let currentBatch: { objectId: string, innerType: string }[] = [];
    let zeroCoins: { objectId: string, innerType: string }[] = [];

    // First collect all zero coins
    do {
        pagObjRes = await client.getOwnedObjects({
            owner: signer.toSuiAddress(),
            filter: { StructType: "0x2::coin::Coin" },
            options: { showType: true, showContent: true },
            cursor,
        });
        cursor = pagObjRes.nextCursor ?? null;

        for (const objResp of pagObjRes.data) {
            const objFields = objResToFields(objResp);
            const objData = objResp.data!;
            const fullType = objData.type!;
            const innerType = (/<(.+)>/.exec(fullType))?.[1];
            if (!innerType) {
                throw new Error(`Can't parse coin type: ${fullType}`);
            }
            if (objFields.balance !== "0") {
                continue;
            }
            zeroCoins.push({
                objectId: objData.objectId,
                innerType,
            });
        }
    } while (pagObjRes.hasNextPage);

    // Calculate total batches
    totalBatches = Math.ceil(zeroCoins.length / MAX_CALLS_PER_TX);

    // Process coins in batches
    for (let i = 0; i < zeroCoins.length; i++) {
        currentBatch.push(zeroCoins[i]);

        if (currentBatch.length >= MAX_CALLS_PER_TX || i === zeroCoins.length - 1) {
            await processBatch(currentBatch);
            currentBatch = [];
        }
    }

    if (!devInspect) {
        log(`Gas used: ${totalGas / 1_000_000_000} SUI`);
    }
}

async function executeTransaction(
    tx: Transaction,
    client: SuiClient,
    signer: Signer,
    devInspect: boolean,
): Promise<DevInspectResults | SuiTransactionBlockResponse>
{
    let resp: DevInspectResults | SuiTransactionBlockResponse;

    if (devInspect) {
        resp = await client.devInspectTransactionBlock({
            transactionBlock: tx,
            sender: signer.toSuiAddress(),
        });
    } else {
        resp = await signAndExecuteTx({ client, tx, signer });
    }

    const info = {
        digest: "",
        status: resp.effects?.status.status,
        gasUsed: resp.effects?.gasUsed,
        deleted: resp.effects?.deleted?.map(obj => obj.objectId)
    };
    if ("digest" in resp) {
        info.digest = resp.digest;
    }
    debug("tx response", info);

    if (resp.effects?.status.status !== "success") {
        throw new Error("Transaction failed");
    }

    return resp;
}
