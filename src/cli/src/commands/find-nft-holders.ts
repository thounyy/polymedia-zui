import { apiRequestIndexer, sleep, validateAndNormalizeAddress } from "@polymedia/suitcase-core";

import { debug, error } from "../logger.js";

export async function findNftHolders({
    collectionId
}: {
    collectionId: string;
}): Promise<void>
{
    const indexerApiUser = process.env.INDEXER_API_USER ?? atob("dHJhZGVwb3J0Lnh5eg==");
    const indexerApiKey = process.env.INDEXER_API_KEY ?? atob("dm1xVnU1ay5mZTAwZjZlMzEwM2JhNTFkODM1YjIzODJlNjgwOWEyYQ==");
    if (!indexerApiUser || !indexerApiKey) {
        error("missing required environment variables.");
        process.exit(1);
    }

    const holders = new Set<string>();
    let offset = 0;
    while (true) {
        debug("fetching holders from offset", offset);
        const results = await fetchHolders(collectionId, offset, indexerApiUser, indexerApiKey);
        if (results.length === 0) { // no more holders
            break;
        }
        for (const item of results) {
            offset++;
            const address = item.owner && validateAndNormalizeAddress(item.owner);
            if (address) {
                holders.add(address);
            } else {
                debug("skipping null holder");
            }
        }
        await sleep(585); // avoid hitting the 100 req/min rate limit
    }
    console.log(JSON.stringify(Array.from(holders), null, 2));
}

async function fetchHolders(
    collectionId: string,
    offset: number,
    indexerApiUser: string,
    indexerApiKey: string,
): Promise<any[]> {
    const query = `
    query {
        sui {
            nfts(
                where: {
                    collection: { id: { _eq: "${collectionId}" } }
                },
                distinct_on: [ owner ]
                offset: ${offset}
            ) {
                owner
            }
        }
    }
    `;
    const result = await apiRequestIndexer<any>(indexerApiUser, indexerApiKey, query);
    if (!result?.data?.sui?.nfts) {
        throw new Error(`[fetchHolders] unexpected result: ${JSON.stringify(result)}`);
    }
    return result.data.sui.nfts;
}
