const {
    ChainGrpcWasmApi,
    IndexerGrpcAccountPortfolioApi,
    PrivateKey,
    ChainGrpcBankApi,
    MsgExecuteContractCompat,
    MsgExecuteContract,
    IndexerGrpcExplorerStream,
    IndexerRestExplorerApi,
    IndexerGrpcExplorerApi,
    MsgSend
} = require('@injectivelabs/sdk-ts');
const { getNetworkEndpoints, Network } = require('@injectivelabs/networks');
const { DenomClientAsync } = require('@injectivelabs/sdk-ui-ts');
const moment = require('moment');
const fs = require('fs/promises');
const TransactionManager = require("./transactions")
const path = require('path')
var colors = require("colors");
colors.enable();
require('dotenv').config();

class InjectiveTokenTools {

    constructor(config) {
        this.RPC = config.gRpc

        console.log(`Init tools on ${this.RPC}`.bgGreen)

        this.chainGrpcWasmApi = new ChainGrpcWasmApi(this.RPC);
        this.chainGrpcBankApi = new ChainGrpcBankApi(this.RPC)
        this.indexerRestExplorerApi = new IndexerRestExplorerApi(
            `${getNetworkEndpoints(Network.Mainnet).explorer}/api/explorer/v1`,
        )

        const endpoints = getNetworkEndpoints(Network.Mainnet)
        this.indexerGrpcExplorerApi = new IndexerGrpcExplorerApi(endpoints.explorer)


        this.privateKey = PrivateKey.fromMnemonic(process.env.MNEMONIC)
        this.publicKey = this.privateKey.toAddress()

        this.walletAddress = this.privateKey.toAddress().toBech32()
        console.log(`Loaded wallet from private key ${this.walletAddress}`.bgGreen)

        this.txManager = new TransactionManager(this.privateKey)

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

    async getPreSaleParticipants(address, start_time, end_time) {


        let allTransactions = [];
        let transactionHashes = new Set(); // Set to store transaction hashes

        try {


            let transactions =
                await this.indexerRestExplorerApi.fetchAccountTransactions({
                    account: address,
                    params: {
                        account: address,
                        fromNumber: 0,
                        toNumber: 100,
                    },
                })

            let totalTx = transactions.paging.total

            console.log(transactions.paging.total)
            console.log(transactions.transactions.length)

            let currentTransactions = transactions.transactions || [];
            for (const tx of currentTransactions) {
                if (!transactionHashes.has(tx.hash)) {
                    allTransactions.push(tx);
                    transactionHashes.add(tx.hash);
                }
            }

            let from = Number(transactions.paging.to);
            let to = Number(transactions.paging.to) + 100

            while (allTransactions.length < totalTx) {
                transactions =
                    await this.indexerRestExplorerApi.fetchAccountTransactions({
                        account: address,
                        params: {
                            account: address,
                            fromNumber: from,
                            toNumber: to,
                        },
                    })
                console.log(transactions.paging)

                currentTransactions = transactions.transactions || [];
                for (const tx of currentTransactions) {
                    if (!transactionHashes.has(tx.hash)) {
                        allTransactions.push(tx);
                        transactionHashes.add(tx.hash);
                    }
                }
                from = Number(transactions.paging.to);
                to = Number(transactions.paging.to) + 100
            }


        } catch (error) {
            console.error("An error occurred getting pair transactions:", error);
        }

        console.log(`got tx ${allTransactions.length}`);

        await Promise.all(
            allTransactions.map(async (tx) => {


            }))
    }


}

module.exports = InjectiveTokenTools
