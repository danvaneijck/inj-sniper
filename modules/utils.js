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
const fs = require('fs/promises');
const TransactionManager = require("./transactions")
const path = require('path')
var colors = require("colors");
colors.enable();
require('dotenv').config();
const moment = require('moment');

class InjectiveTokenTools {

    constructor(config) {
        this.RPC = config.gRpc

        console.log(`Init tools on ${this.RPC}`.bgGreen)

        this.chainGrpcWasmApi = new ChainGrpcWasmApi(this.RPC);
        this.chainGrpcBankApi = new ChainGrpcBankApi(this.RPC)
        this.indexerRestExplorerApi = new IndexerRestExplorerApi(
            `https://sentry.explorer.grpc-web.injective.network/api/explorer/v1`,
        )

        const endpoints = getNetworkEndpoints(Network.Mainnet)
        this.indexerGrpcExplorerApi = new IndexerGrpcExplorerApi(endpoints.explorer)


        this.privateKey = PrivateKey.fromMnemonic(process.env.MNEMONIC)
        this.publicKey = this.privateKey.toAddress()

        this.walletAddress = this.privateKey.toAddress().toBech32()
        console.log(`Loaded wallet from private key ${this.walletAddress}`.bgGreen)

        this.txManager = new TransactionManager(this.privateKey)

        this.txMap = new Map()
        this.preSaleAmounts = new Map()

    }

    async init() {
        this.txMap = await this.loadMapFromFile("txMap.json", "address")
        // this.preSaleAmounts = await this.loadMapFromFile("presaleAmounts.json", "address")
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

    async readDataFromFile(filename) {
        const filePath = path.resolve(__dirname, '..', 'data', filename);
        try {
            const data = await fs.readFile(filePath, 'utf-8');
            return JSON.parse(data);
        } catch (error) {
            return filename === 'txMap.json' || filename === 'presaleAmounts.json' ? new Map() : new Set();
        }
    }

    async loadMapFromFile(filename, keyProperty) {
        const pairs = await this.readDataFromFile(filename);
        return new Map(pairs.map(item => [item[keyProperty], item]));
    }

    async saveDataToFile(filename, data) {
        const filePath = path.resolve(__dirname, '..', 'data', filename);

        try {
            await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
        } catch (error) {
            console.error(`Error saving ${filename} to file:`, error);
        }
    }

    async getTxFromAddress(address) {
        console.log("get presale")


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

        if (allTransactions.length > 0) {
            this.txMap.set(address, { address: address, txs: allTransactions })
            this.saveDataToFile("txMap.json", Array.from(this.txMap.values()))
            console.log(this.txMap.get(address))
        }

    }

    async getTxFromAddress(address) {
        const account = await this.indexerGrpcExplorerApi.fetchAccountTx({
            address: address,
            type: ""
        })
    }

    async getPreSaleAmounts(address, startTime, endTime, max, maxPerWallet) {
        let allTransactions = this.txMap.get(address)
        console.log(allTransactions.txs.length)

        let maxCap = max * Math.pow(10, 18)
        let amountRaised = 0
        let toRefund = 0


        allTransactions.txs.forEach(async (tx) => {
            let messageError = tx.errorLog.length > 1
            if (messageError) {
                console.log("tx error")
                return
            }

            let blockNumber = tx.blockNumber
            let blockTimestamp = moment(tx.blockTimestamp)

            tx.messages.forEach(async (message) => {
                let sender, recipient, amount = null
                if (
                    message.message.msg !== undefined &&
                    message.message.msg !== null
                    && typeof message.message.msg === 'string'
                    && message.message.msg.includes("transfer")
                    && !message.message.contract
                ) {
                    let msg = JSON.parse(message.message.msg)
                    sender = message.message['sender']
                    recipient = msg['transfer']['recipient']
                    amount = msg['transfer']['amount']
                }
                else if (message.type == "/cosmos.bank.v1beta1.MsgSend") {
                    amount = message.message.amount
                    if (amount[0].denom == "inj") {
                        amount = amount[0].amount
                    }
                    else {
                        amount == null
                    }
                    sender = message.message['from_address']
                    recipient = message.message['to_address']
                }
                else {
                    // sending out the memes
                    return
                }

                if (!sender) {
                    console.log("no sender")
                }
                if (!recipient) {
                    console.log("no recipient")
                }
                if (!amount) {
                    console.log("no amount")
                }

                let inTimeFrame = blockTimestamp.isAfter(startTime) && blockTimestamp.isBefore(endTime)
                let withinMaxCap = amountRaised + Number(amount) < maxCap

                if (inTimeFrame && withinMaxCap && recipient == address) {
                    amountRaised += Number(amount)
                }
                else {
                    toRefund += Number(amount)
                }

                if (sender && recipient && amount) {
                    if (sender == address) {
                        let participant = recipient
                        if (this.preSaleAmounts.has(participant)) {
                            let entry = this.preSaleAmounts.get(participant)
                            this.preSaleAmounts.set(participant, {
                                ...entry,
                                address: participant,
                                amountRefunded: Number(amount) + Number(entry.amountRefunded ?? 0)
                            })
                        }
                        else {
                            this.preSaleAmounts.set(participant, {
                                address: participant,
                                amountRefunded: Number(amount)
                            })
                        }
                    }
                    else {
                        // received funds for presale 
                        if (this.preSaleAmounts.has(sender)) {
                            let entry = this.preSaleAmounts.get(sender)

                            let totalSent = Number(amount) + Number(entry.amountSent ?? 0)
                            let toRefund = 0
                            if (!withinMaxCap || !inTimeFrame) {
                                toRefund = Number(amount)
                            }

                            this.preSaleAmounts.set(sender, {
                                ...entry,
                                address: sender,
                                toRefund: toRefund,
                                amountSent: totalSent
                            })
                        }
                        else {
                            let toRefund = 0
                            if (!withinMaxCap || !inTimeFrame) {
                                toRefund = Number(amount)
                            }
                            this.preSaleAmounts.set(sender, {
                                address: sender,
                                amountSent: Number(amount),
                                toRefund: toRefund
                            })
                        }
                    }
                }
            })
        })

        console.log("amount raised: ", amountRaised / Math.pow(10, 18))
        console.log("to refund: ", toRefund / Math.pow(10, 18))

        let myAddress = this.preSaleAmounts.get("inj1lq9wn94d49tt7gc834cxkm0j5kwlwu4gm65lhe")
        console.log(myAddress)
        this.saveDataToFile("presaleAmounts.json", Array.from(this.preSaleAmounts.values()))
    }


}

module.exports = InjectiveTokenTools
