require('dotenv').config();

class Astroport {
    constructor(chainGrpcWasmApi, indexerRestExplorerApi, baseAsset) {
        this.chainGrpcWasmApi = chainGrpcWasmApi;
        this.indexerRestExplorerApi = indexerRestExplorerApi;
        this.astroRouter = process.env.ASTRO_ROUTER_CONTRACT;
        this.astroFactory = process.env.ASTRO_FACTORY_CONTRACT
        this.baseDenom = baseAsset.denom;
        this.baseAsset = baseAsset;
    }

    async getTxByHash(txHash) {
        try {
            const txsHash = txHash
            const transaction = await this.indexerRestExplorerApi.fetchTransaction(txsHash)
            return transaction
        }
        catch (e) {
            console.log(`Error fetching tx by hash: ${e}`)
        }
        return null
    }

    async checkForNewPairs(allPairs, ignoredPairs) {
        const startTime = new Date().getTime();

        const contractAddress = this.astroFactory;
        const limit = 10;
        const skip = 0;

        const transactions = await this.indexerRestExplorerApi.fetchContractTransactions({
            contractAddress,
            params: {
                limit,
                skip,
            },
        });

        const newPairs = []

        await Promise.all(
            transactions.transactions.map(async (tx) => {
                const txHash = tx.txHash;
                let txInfo = await this.getTxByHash(txHash);
                if (!txInfo || !txInfo.logs) {
                    // console.log(txInfo)
                    return
                }
                if (txInfo['errorLog'].length > 0) {
                    return
                }
                await Promise.all(
                    txInfo.messages.map(async (msg) => {
                        let message;
                        try {
                            message = JSON.parse(msg.message.msg);
                        } catch (error) {
                            message = msg.message.msg;
                        }
                        if (typeof message === 'object') {
                            const firstKey = Object.keys(message)[0];
                            if (firstKey == "create_pair") {
                                const pairAddress = txInfo.logs[0].events[txInfo.logs[0].events.length - 1].attributes.find((attr) => attr.key === "pair_contract_addr").value;
                                if (!allPairs.has(pairAddress) && !ignoredPairs.has(pairAddress)) {
                                    newPairs.push({
                                        "address": pairAddress,
                                        "tx": txInfo,
                                        "txHash": txHash,
                                        "factory": this.astroFactory
                                    })
                                }
                            }
                        }
                    })
                );
            })
        );

        const endTime = new Date().getTime();
        const executionTime = endTime - startTime;
        // console.log(`Finished check for new pairs on Astroport in ${executionTime} milliseconds`.gray);

        return newPairs
    }

    async getQuoteFromRouter(pair, amount) {
        if (!pair || !pair.asset_infos || !Array.isArray(pair.asset_infos)) {
            console.error(`Invalid pair or asset_infos for AstroSwap getQuoteFromRouter:`, pair);
            return;
        }

        const pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`;
        const askAssetIndex = pair.asset_infos.findIndex(assetInfo => {
            const isNativeToken = assetInfo.native_token && assetInfo.native_token.denom !== this.baseDenom;
            const isCW20Token = assetInfo.token && assetInfo.token.contract_addr !== this.baseDenom;
            return isNativeToken || isCW20Token;
        });
        if (askAssetIndex === -1) {
            console.error(`Error finding AstroSwap ask asset for ${pairName}`);
            return;
        }

        const askAssetInfo = pair.asset_infos[askAssetIndex];
        const offerAmount = amount * Math.pow(10, this.baseAsset.decimals);

        const simulationQuery = {
            simulate_swap_operations: {
                offer_amount: offerAmount.toString(),
                operations: [
                    {
                        astro_swap: {
                            offer_asset_info: {
                                native_token: {
                                    denom: this.baseDenom
                                }
                            },
                            ask_asset_info: askAssetInfo
                        }
                    }
                ]
            }
        };

        try {
            const query = Buffer.from(JSON.stringify(simulationQuery)).toString('base64');
            const sim = await this.chainGrpcWasmApi.fetchSmartContractState(this.astroRouter, query);

            const decodedData = JSON.parse(new TextDecoder().decode(sim.data));
            return decodedData;
        } catch (error) {
            console.error(`Error getting AstroSwap quote for ${pairName}: ${error}`);
        }
    }

    async getSellQuoteFromRouter(pair, amount) {
        const pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`;

        try {
            if (!pair || !pair.asset_infos || !Array.isArray(pair.asset_infos)) {
                throw new Error(`Invalid pair or asset_infos for AstroSwap getSellQuoteFromRouter: ${pair}`);
            }

            const assetToSell = pair.asset_infos.findIndex(assetInfo => {
                const isNativeToken = assetInfo.native_token && assetInfo.native_token.denom !== this.baseDenom;
                const isCW20Token = assetInfo.token && assetInfo.token.contract_addr !== this.baseDenom
                return isNativeToken || isCW20Token;
            });

            if (assetToSell === -1) {
                throw new Error(`Error finding AstroSwap ask asset for ${pairName}`);
            }
            const assetInfo = pair.asset_infos[assetToSell];

            const simulationQuery = {
                simulate_swap_operations: {
                    offer_amount: amount.toString(),
                    operations: [
                        {
                            astro_swap: {
                                offer_asset_info: assetInfo,
                                ask_asset_info: {
                                    native_token: {
                                        denom: this.baseDenom
                                    }
                                }
                            }
                        }
                    ]
                }
            };

            const query = Buffer.from(JSON.stringify(simulationQuery)).toString('base64');
            const sim = await this.chainGrpcWasmApi.fetchSmartContractState(this.astroRouter, query);
            const decodedData = JSON.parse(new TextDecoder().decode(sim.data));
            return decodedData;
        } catch (error) {
            console.error(`Error getting AstroSwap sell quote for ${pairName}: ${error}`);
            return null;
        }
    }
}

module.exports = Astroport;