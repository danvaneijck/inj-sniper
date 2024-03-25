const {
    ChainGrpcWasmApi,
    PrivateKey,
    ChainGrpcBankApi,
    IndexerRestExplorerApi,
    IndexerGrpcExplorerApi, MsgSend
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
const csv = require('csv-parser');


class InjectiveTokenTools {

    constructor(config) {
        this.RPC = config.gRpc

        console.log(`Init tools on ${this.RPC}`.bgGreen)

        this.chainGrpcWasmApi = new ChainGrpcWasmApi(this.RPC);
        this.chainGrpcBankApi = new ChainGrpcBankApi(this.RPC);

        this.indexerRestExplorerApi = new IndexerRestExplorerApi(config.explorerAPI)
        this.indexerGrpcExplorerApi = new IndexerGrpcExplorerApi(config.endpoints.explorer)

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
        console.log("finish init")
    }

    async createNewWallet() {

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
        console.log("get presale tx from address", address)

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
            await this.saveDataToFile("txMap.json", Array.from(this.txMap.values()))
        }

    }

    async getPreSaleAmounts(address, startTime, endTime, max, minPerWallet, maxPerWallet) {
        let allTransactions = this.txMap.get(address)
        console.log("total tx to scan: ", allTransactions.txs.length)

        // console.log("start", startTime.format())
        // console.log("end", endTime.format())
        console.log(`min contribution: ${minPerWallet} INJ`)
        console.log(`max contribution: ${maxPerWallet} INJ`)

        console.log("max cap", max, "INJ")

        let maxCap = max * Math.pow(10, 18)
        let minContribution = minPerWallet * Math.pow(10, 18)
        let maxContribution = maxPerWallet * Math.pow(10, 18)

        let totalAmountReceived = 0
        let totalValidContributions = 0
        let totalToRefund = 0

        let maxCapHit = false
        let maxCapBlock = null

        allTransactions.txs.sort((a, b) => {
            return a.blockNumber - b.blockNumber;
        });

        allTransactions.txs.forEach(async (tx) => {
            let messageError = tx.errorLog.length > 1
            if (messageError) {
                return
            }

            let blockNumber = tx.blockNumber
            let blockTimestamp = moment(tx.blockTimestamp, "YYYY-MM-DD HH:mm:ss.SSS Z")

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

                if (recipient == address) {
                    totalAmountReceived += Number(amount)
                }

                if (Number(amount < minContribution || Number(amount) > maxContribution)) {
                    // console.log("amount outside of min max", amount / Math.pow(10, 18), message)
                    let totalSent = Number(amount)
                    let toRefund = Number(amount)
                    let entry = this.preSaleAmounts.get(sender)

                    if (entry) {
                        totalSent += Number(entry.amountSent ?? 0)
                        toRefund += Number(entry.toRefund ?? 0)
                    }

                    this.preSaleAmounts.set(sender, {
                        ...entry,
                        address: sender,
                        amountSent: totalSent,
                        contribution: Number(totalSent) - Number(toRefund),
                        toRefund: toRefund,
                    })
                    totalValidContributions += Number(totalSent) - Number(toRefund)

                    return
                }

                let inTimeFrame = blockTimestamp.isAfter(startTime) && blockTimestamp.isBefore(endTime)

                let withinMaxCap = Number(totalValidContributions) + Number(amount) <= maxCap
                let room = maxCap - Number(totalValidContributions)

                if (!withinMaxCap && maxCapHit == false && (room / Math.pow(10, 18)) > 1) {
                    console.log(`transfer of ${amount / Math.pow(10, 18)} INJ puts sale over max of ${max}. space left: ${(room / Math.pow(10, 18)).toFixed(2)} INJ`)
                    let totalSent = Number(amount)
                    let toRefund = Number(amount)
                    let entry = this.preSaleAmounts.get(sender)

                    if (entry) {
                        totalSent += Number(entry.amountSent ?? 0)
                        toRefund += Number(entry.toRefund ?? 0)
                    }

                    this.preSaleAmounts.set(sender, {
                        ...entry,
                        address: sender,
                        amountSent: totalSent,
                        contribution: Number(totalSent) - Number(toRefund),
                        toRefund: toRefund,
                    })
                    totalValidContributions += Number(totalSent) - Number(toRefund)
                    return
                }

                if (!withinMaxCap && maxCapHit == false && room < 5) {
                    maxCapHit = blockTimestamp
                    maxCapBlock = blockNumber
                    console.log("max cap hit")
                }

                if (sender && recipient && amount) {
                    if (sender == address) {
                        // potentially doing a refund
                        let participant = recipient
                        if (this.preSaleAmounts.has(participant)) {
                            let entry = this.preSaleAmounts.get(participant)
                            this.preSaleAmounts.set(participant, {
                                ...entry,
                                address: participant,
                            })
                        }
                    }
                    else {
                        // received funds for presale 
                        if (this.preSaleAmounts.has(sender)) {
                            let entry = this.preSaleAmounts.get(sender)
                            let totalSent = Number(amount) + Number(entry.amountSent ?? 0)
                            let toRefund = 0 + Number(entry.toRefund ?? 0)

                            if (!withinMaxCap) {
                                toRefund += Number(amount)
                            }

                            this.preSaleAmounts.set(sender, {
                                ...entry,
                                address: sender,
                                amountSent: totalSent,
                                contribution: Number(totalSent) - Number(toRefund),
                                toRefund: toRefund,
                            })
                            totalValidContributions += Number(totalSent) - Number(toRefund)
                        }
                        else {
                            let toRefund = 0
                            if (!withinMaxCap) {
                                toRefund += Number(amount)
                            }
                            this.preSaleAmounts.set(sender, {
                                address: sender,
                                timeSent: blockTimestamp.format(),
                                amountSent: Number(amount),
                                contribution: Number(amount) - Number(toRefund),
                                toRefund: toRefund,
                            })
                            totalValidContributions += Number(amount) - Number(toRefund)
                        }
                    }
                }
            })
        })

        console.log("total amount received: ", (totalAmountReceived / Math.pow(10, 18)).toFixed(2), "INJ")

        this.saveDataToFile("presaleAmounts.json", Array.from(this.preSaleAmounts.values()))

        // sanity check
        let totalRefunded = 0
        let totalContribution = 0

        Array.from(this.preSaleAmounts.values()).forEach((entry) => {
            totalRefunded += entry.amountRefunded ?? 0
            totalContribution += entry.contribution ?? 0
            totalToRefund += entry.toRefund ?? 0
            if (entry.amountSent - entry.toRefund - entry.contribution != 0) {
                console.log(entry)
            }
        })

        console.log("to refund: ", (totalToRefund / Math.pow(10, 18)).toFixed(2), "INJ")
        console.log("total contributions: ", (totalContribution / Math.pow(10, 18)).toFixed(2), "INJ")

        console.log("max cap hit: ", maxCapHit && maxCapHit.format(), "block number: ", maxCapBlock)

        let totalR = Number((totalAmountReceived / Math.pow(10, 18)).toFixed(2))
        let totalC = Number((totalContribution / Math.pow(10, 18)).toFixed(2))
        let totalRef = Number((totalToRefund / Math.pow(10, 18)).toFixed(2))

        let leftOver = totalR - totalC - totalRef

        // console.log(`${totalR} - ${totalC} - ${totalRef} = ${leftOver}`)
        return totalC

    }

    async generateRefundList() {
        let csvData = ""

        this.preSaleAmounts.forEach((entry, address) => {
            if (entry.toRefund > 0) csvData += `${address},${entry.toRefund}\n`;
        });

        await fs.writeFile("data/refunds.csv", csvData);

        console.log("\nsaved refund amounts csv")
    }

    async generateAirdropCSV(totalContribution, totalSupply, decimals, percentToAirdrop, outputFile) {
        console.log(`\ntotal supply: ${totalSupply}`)

        let amountToDrop = (totalSupply * Math.pow(10, decimals)) * percentToAirdrop
        console.log(`number of tokens to airdrop: ${amountToDrop / Math.pow(10, decimals)}`)

        console.log(`total raised INJ: ${totalContribution}`)

        let price = (totalContribution * Math.pow(10, 18)) / amountToDrop
        console.log(`LP starting price: ${price.toFixed(8)} INJ`)

        let dropAmounts = new Map()

        let tracking = 0

        Array.from(this.preSaleAmounts.values()).forEach((entry) => {
            if (entry.contribution <= 0) return

            if (entry.contribution > 100 * Math.pow(10, 18)) {
                console.log(`over max: ${entry}`)
            }

            let sender = entry.address
            let percentOfSupply = Number(entry.contribution) / Number(totalContribution * Math.pow(10, 18))

            let numberForUser = amountToDrop * percentOfSupply
            dropAmounts.set(sender, numberForUser);
            tracking += numberForUser / Math.pow(10, 18)
        })

        console.log(`total to send ${tracking} to ${dropAmounts.size} participants`)

        // Write data to CSV file
        let csvData = "";
        dropAmounts.forEach((amount, sender) => {
            csvData += `${sender},${amount}\n`;
        });

        await fs.writeFile(outputFile, csvData, (err) => {
            if (err) {
                console.error("Error writing CSV file:", err);
            } else {
                console.log(`airdrop CSV file "${outputFile}" saved successfully.`);
            }
        });

        console.log("\nsaved airdrop amounts csv\n")
    }

    async sendRefunds(fromAddress) {
        console.log("\nsend refunds")
        const map = new Map();

        try {
            const file = await fs.readFile('data/refunds.csv', { encoding: "utf8" })
            file
                .split('\n')
                .forEach(line => {
                    if (line.trim() !== '') {
                        const row = line.split(',');
                        map.set(row[0], row[1])
                    }
                });
        } catch (error) {
            console.error('Error reading CSV file:', error);
        }

        map.forEach(async (amount, address) => {
            const msg = MsgSend.fromJSON({
                amount,
                srcInjectiveAddress: fromAddress,
                dstInjectiveAddress: address,
            })
            let result = await this.txManager.enqueue(msg)
            console.log(result)
        })
    }

}

module.exports = InjectiveTokenTools
