import { Command } from '../Commando.js';
import { readJsonFile, writeJsonFile } from '../lib/file_utils.js';
import { MultiSuiClient, SuiClientWithEndpoint } from '../lib/sui_utils.js';
import { AddressAndBalance } from '../types.js';

export class FindCoinBalancesCommand implements Command {
    private coinType = '';
    private inputFile = '';
    private outputFile = '';

    public getDescription(): string {
        return 'Find how much Coin<T> is owned by each address';
    }

    public getUsage(): string {
        return `${this.getDescription()}

Usage:
  find_coin_balances COIN_TYPE INPUT_FILE OUTPUT_FILE

Arguments:
  COIN_TYPE     The type of the coin (the T in Coin<T>)
  INPUT_FILE    Path to the input JSON file. It looks like this:
                [ { address: string, balance: number }, ... ]
  OUTPUT_FILE   Path to the output JSON file. It looks like this:
                [ { address: string, balance: number }, ... ]

Example:
  find_coin_balances 0x123::lol::LOL coin_holders.json coin_balances.json
`;
    }

    public async execute(args: string[]): Promise<void>
    {
        /* Read command arguments */

        if (args.length !== 3) {
            console.log(this.getUsage());
            return;
        }
        this.coinType = args[0];
        this.inputFile = args[1];
        this.outputFile = args[2];
        console.log(`coinType: ${this.coinType}`);
        console.log(`inputFile: ${this.inputFile}`);
        console.log(`outputFile: ${this.outputFile}`);

        /* Find how much Coin<T> is owned by each address */

        const inputs: AddressAndBalance[] = readJsonFile(this.inputFile);
        console.log(`Fetching ${inputs.length} balances in batches...`);

        const multiClient = new MultiSuiClient();
        const fetchBalance = (client: SuiClientWithEndpoint, input: AddressAndBalance) => {
            return client.getBalance({
                owner: input.address,
                coinType: this.coinType,
            }).then(balance => {
                return { address: input.address, balance: balance.totalBalance };
            }).catch(error => {
                console.error(`Error getting balance for address ${input.address} from rpc ${client.endpoint}: ${error}`);
                throw error;
            });
        };
        const balances = await multiClient.executeInBatches(inputs, fetchBalance);

        writeJsonFile(this.outputFile, balances);
    }
}
