const {
    ChainGrpcWasmApi,
    PrivateKey,
    ChainGrpcBankApi,
    IndexerRestExplorerApi,
    IndexerGrpcExplorerApi,
    MsgSend,
    MsgInstantiateContract,
    MsgExecuteContractCompat,
    IndexerGrpcAccountPortfolioApi,
    MsgExecuteContract,
} = require("@injectivelabs/sdk-ts");
const { DEFAULT_STD_FEE } = require("@injectivelabs/utils");
const { DenomClientAsync } = require("@injectivelabs/sdk-ui-ts");
const fs = require("fs/promises");
const TransactionManager = require("./transactions");
const path = require("path");
var colors = require("colors");
colors.enable();
require("dotenv").config();
const moment = require("moment");
const csv = require("csv-parser");

class InjectiveTokenTools {
    constructor(endpoints) {
        this.endpoints = endpoints;
        this.RPC = endpoints.grpc;

        this.dojoBurnAddress = "inj1wu0cs0zl38pfss54df6t7hq82k3lgmcdex2uwn";

        console.log(`Init tools on ${this.RPC}`.bgGreen);

        this.chainGrpcWasmApi = new ChainGrpcWasmApi(this.RPC);
        this.chainGrpcBankApi = new ChainGrpcBankApi(this.RPC);

        this.indexerRestExplorerApi = new IndexerRestExplorerApi(
            endpoints.explorer
        );

        this.privateKey = PrivateKey.fromMnemonic(process.env.MNEMONIC);
        this.publicKey = this.privateKey.toAddress();

        this.walletAddress = this.privateKey.toAddress().toBech32();
        console.log(
            `Loaded wallet from private key ${this.walletAddress}`.bgGreen
        );

        this.txManager = new TransactionManager(this.privateKey, endpoints);

        this.txMap = new Map();
        this.preSaleAmounts = new Map();
    }

    async init() {
        this.txMap = await this.loadMapFromFile("txMap.json", "address");
    }

    async getTxByHash(txHash) {
        try {
            const txsHash = txHash;
            const transaction =
                await this.indexerRestExplorerApi.fetchTransaction(txsHash);
            return transaction;
        } catch (e) {
            console.log(`Error fetching tx by hash: ${e}`);
        }
        return null;
    }

    async readDataFromFile(filename) {
        const filePath = path.resolve(__dirname, "..", "data", filename);
        try {
            const data = await fs.readFile(filePath, "utf-8");
            return JSON.parse(data);
        } catch (error) {
            return filename === "txMap.json" ||
                filename === "presaleAmounts.json"
                ? new Map()
                : new Set();
        }
    }

    async loadMapFromFile(filename, keyProperty) {
        const pairs = await this.readDataFromFile(filename);
        return new Map(pairs.map((item) => [item[keyProperty], item]));
    }

    async saveDataToFile(filename, data) {
        const filePath = path.resolve(__dirname, "..", "data", filename);

        try {
            await fs.writeFile(
                filePath,
                JSON.stringify(data, null, 2),
                "utf-8"
            );
        } catch (error) {
            console.error(`Error saving ${filename} to file:`, error);
        }
    }

    async getTxFromAddress(address) {
        console.log("get presale tx from address", address);

        try {
            let allTransactions = [];
            let transactionHashes = new Set(); // Set to store transaction hashes

            let from = 0;
            let to = 100;

            let transactions;
            let totalTx;

            do {
                transactions =
                    await this.indexerRestExplorerApi.fetchAccountTransactions({
                        account: address,
                        params: {
                            account: address,
                            fromNumber: from,
                            toNumber: to,
                        },
                    });

                totalTx = transactions.paging.total;

                const currentTransactions = transactions.transactions || [];
                for (const tx of currentTransactions) {
                    if (!transactionHashes.has(tx.hash)) {
                        allTransactions.push(tx);
                        transactionHashes.add(tx.hash);
                    }
                }

                from = to;
                to += 100;
            } while (allTransactions.length < totalTx);

            if (allTransactions.length > 0) {
                this.txMap.set(address, {
                    address: address,
                    txs: allTransactions,
                });
                await this.saveDataToFile(
                    "txMap.json",
                    Array.from(this.txMap.values())
                );
            }
        } catch (error) {
            console.error(
                "An error occurred getting pair transactions:",
                error
            );
        }
    }

    async getPreSaleAmounts(address, max, minPerWallet, maxPerWallet, tokenAddress = null) {
        let allTransactions = this.txMap.get(address);
        if (!allTransactions) {
            console.log("no tx yet");
            return;
        }
        console.log("total tx to scan: ", allTransactions.txs.length);

        let maxCap = max * Math.pow(10, 18);
        let minContribution = minPerWallet * Math.pow(10, 18);
        let maxContribution = maxPerWallet * Math.pow(10, 18);

        let totalAmountReceived = 0;
        let totalValidContributions = 0;
        let totalToRefund = 0;

        let maxCapHit = false;
        let maxCapBlock = null;

        allTransactions.txs.sort((a, b) => {
            return a.blockNumber - b.blockNumber;
        });

        allTransactions.txs.forEach(async (tx) => {
            let messageError = tx.errorLog.length > 1;
            if (messageError) {
                return;
            }

            let blockNumber = tx.blockNumber;
            let blockTimestamp = moment(
                tx.blockTimestamp,
                "YYYY-MM-DD HH:mm:ss.SSS Z"
            );

            tx.messages.forEach(async (message) => {
                let sender,
                    recipient,
                    amount = null;

                if (
                    message.message.msg &&
                    typeof message.message.msg === "string" &&
                    message.message.msg.includes("transfer") &&
                    !message.message.contract
                ) {
                    let msg = JSON.parse(message.message.msg);
                    sender = message.message["sender"];
                    recipient = msg["transfer"]["recipient"];
                    amount = msg["transfer"]["amount"];
                } else if (message.type == "/cosmos.bank.v1beta1.MsgSend") {
                    amount = message.message.amount
                        ? message.message.amount[0].denom == "inj"
                            ? message.message.amount[0].amount
                            : null
                        : null;
                    sender = message.message["from_address"];
                    recipient = message.message["to_address"];
                } else {
                    // sending out the memes
                    if (tokenAddress !== null && message.message.contract == tokenAddress && message.type == "/cosmwasm.wasm.v1.MsgExecuteContract") {
                        let msg = message.message.msg
                        recipient = msg["transfer"]["recipient"];
                        amount = msg["transfer"]["amount"];
                        console.log(`airdropped ${recipient}, amount: ${amount}`.bgCyan)
                        let entry = this.preSaleAmounts.get(recipient);
                        this.preSaleAmounts.set(recipient, {
                            ...entry,
                            address: recipient,
                            tokensSent: amount
                        });
                    }
                    return;
                }

                if (recipient == address) {
                    totalAmountReceived += Number(amount);
                }

                if (
                    recipient == address &&
                    (Number(amount) < minContribution ||
                        Number(amount) > maxContribution)
                ) {
                    let entry = this.preSaleAmounts.get(sender);
                    let totalSent =
                        Number(amount) +
                        (entry ? Number(entry.amountSent ?? 0) : 0);
                    let toRefund = 0;

                    if (totalSent > maxContribution) {
                        toRefund = totalSent - maxContribution;
                    } else if (totalSent < minContribution) {
                        toRefund = Number(amount);
                    }

                    this.preSaleAmounts.set(sender, {
                        ...entry,
                        address: sender,
                        amountSent: totalSent,
                        contribution: totalSent - toRefund,
                        toRefund: toRefund,
                    });
                    totalValidContributions += totalSent - toRefund;
                    return;
                }

                let withinMaxCap =
                    Number(totalValidContributions) + Number(amount) <= maxCap;
                let room = maxCap - Number(totalValidContributions);

                if (
                    !withinMaxCap &&
                    maxCapHit == false &&
                    room / Math.pow(10, 18) > 1
                ) {
                    console.log(
                        `transfer of ${amount / Math.pow(10, 18)
                        } INJ puts sale over max of ${max}. space left: ${(
                            room / Math.pow(10, 18)
                        ).toFixed(2)} INJ`
                    );
                    let totalSent = Number(amount);
                    let toRefund = Number(amount);
                    let entry = this.preSaleAmounts.get(sender);

                    if (entry) {
                        totalSent += Number(entry.amountSent ?? 0);
                        toRefund += Number(entry.toRefund ?? 0);
                    }

                    this.preSaleAmounts.set(sender, {
                        ...entry,
                        address: sender,
                        amountSent: totalSent,
                        contribution: Number(totalSent) - Number(toRefund),
                        toRefund: toRefund,
                    });
                    totalValidContributions +=
                        Number(totalSent) - Number(toRefund);
                    return;
                }

                if (!withinMaxCap && maxCapHit == false && room < 5) {
                    maxCapHit = blockTimestamp;
                    maxCapBlock = blockNumber;
                    console.log("max cap hit");
                }

                if (sender && recipient && amount) {
                    if (sender == address) {
                        console.log("SENDER IS ME");
                        // potentially doing a refund
                        let participant = recipient;
                        if (this.preSaleAmounts.has(participant)) {
                            let entry = this.preSaleAmounts.get(participant);
                            console.log(entry)
                            let amountRefunded =
                                (entry.amountRefunded ?? 0) + Number(amount);
                            this.preSaleAmounts.set(participant, {
                                ...entry,
                                address: participant,
                                amountRefunded: amountRefunded,
                                contribution:
                                    (entry.contribution ?? 0) - amountRefunded,
                                toRefund: (entry.toRefund ?? 0) - amountRefunded
                            });
                        }
                    } else {
                        // received funds for presale
                        if (this.preSaleAmounts.has(sender)) {
                            let entry = this.preSaleAmounts.get(sender);
                            let totalSent =
                                Number(amount) + (entry.amountSent ?? 0);
                            let toRefund = 0;

                            if (!withinMaxCap) {
                                toRefund += Number(amount);
                            }

                            if (totalSent > maxContribution) {
                                toRefund = totalSent - maxContribution;
                            } else if (totalSent < minContribution) {
                                toRefund = amount;
                            }

                            this.preSaleAmounts.set(sender, {
                                ...entry,
                                address: sender,
                                amountSent: totalSent,
                                contribution: totalSent - toRefund,
                                toRefund: toRefund,
                            });
                            totalValidContributions += totalSent - toRefund;
                        } else {
                            let toRefund = !withinMaxCap ? Number(amount) : 0;
                            this.preSaleAmounts.set(sender, {
                                address: sender,
                                timeSent: blockTimestamp.format(),
                                amountSent: Number(amount),
                                contribution: Number(amount) - toRefund,
                                toRefund: toRefund,
                            });
                            totalValidContributions +=
                                Number(amount) - toRefund;
                        }
                    }
                }
            });
        });

        console.log(
            "total amount received: ",
            (totalAmountReceived / Math.pow(10, 18)).toFixed(2),
            "INJ"
        );

        this.saveDataToFile(
            "presaleAmounts.json",
            Array.from(this.preSaleAmounts.values())
        );

        let totalRefunded = 0;
        let totalContribution = 0;

        Array.from(this.preSaleAmounts.values()).forEach((entry) => {
            totalRefunded += entry.amountRefunded ?? 0;
            totalContribution += entry.contribution ?? 0;
            totalToRefund += entry.toRefund ?? 0;
            if (entry.amountSent - entry.toRefund - entry.contribution != 0) {
                console.log(entry);
            }
        });

        console.log(
            "to refund: ",
            (totalToRefund / Math.pow(10, 18)).toFixed(2),
            "INJ"
        );
        console.log(
            "total contributions: ",
            (totalContribution / Math.pow(10, 18)).toFixed(2),
            "INJ"
        );

        console.log(
            "max cap hit: ",
            maxCapHit && maxCapHit.format(),
            "block number: ",
            maxCapBlock
        );

        let totalR = Number(
            (totalAmountReceived / Math.pow(10, 18)).toFixed(2)
        );
        let totalC = Number((totalContribution / Math.pow(10, 18)).toFixed(2));
        let totalRef = Number((totalToRefund / Math.pow(10, 18)).toFixed(2));

        let leftOver = totalR - totalC - totalRef;

        console.log(`${totalR} - ${totalC} - ${totalRef} = ${leftOver}`);
        return totalC;
    }

    async generateRefundList() {
        const csvData = [...this.preSaleAmounts.entries()]
            .filter(([_, entry]) => (entry.toRefund - (entry.amountRefunded ?? 0)) > 0)
            .map(([address, entry]) => `${address},${entry.toRefund - (entry.amountRefunded ?? 0)}`)
            .join("\n");

        await fs.writeFile("data/refunds.csv", csvData + "\n");

        console.log("\nsaved refund amounts csv");
    }

    async generateAirdropCSV(
        totalContribution,
        totalSupply,
        decimals,
        percentToAirdrop,
        devAllocation,
        outputFile
    ) {
        let amountToDrop =
            totalSupply * Math.pow(10, decimals) * percentToAirdrop;
        let forDev = totalSupply * Math.pow(10, decimals) * devAllocation;
        amountToDrop -= forDev;

        console.log(`dev allocated tokens: ${forDev / Math.pow(10, 18)}`);
        console.log(
            `number of tokens to airdrop: ${amountToDrop / Math.pow(10, decimals)
            }`
        );
        console.log(`total raised INJ: ${totalContribution}`);
        console.log(
            `LP starting price: ${(totalContribution * Math.pow(10, 18)) / amountToDrop.toFixed(8)
            } INJ`
        );

        let dropAmounts = new Map();
        let tracking = 0;

        Array.from(this.preSaleAmounts.values()).forEach((entry) => {
            if (entry.contribution <= 0) return;

            if (entry.contribution > 100 * Math.pow(10, 18)) {
                console.log(`over max: ${entry}`);
            }

            let sender = entry.address;
            let percentOfSupply =
                Number(entry.contribution) /
                Number(totalContribution * Math.pow(10, 18));
            let numberForUser = amountToDrop * percentOfSupply;

            dropAmounts.set(
                sender,
                (numberForUser / Math.pow(10, 18)).toFixed(0) + "0".repeat(18)
            );
            tracking += numberForUser / Math.pow(10, 18);
        });

        console.log(
            `total to send ${tracking} to ${dropAmounts.size} participants`
        );

        let csvData = "";
        dropAmounts.forEach((amount, sender) => {
            csvData += `${sender},${amount}\n`;
        });

        try {
            await fs.writeFile(outputFile, csvData);
            console.log(`airdrop CSV file "${outputFile}" saved successfully.`);
        } catch (err) {
            console.error("Error writing CSV file:", err);
        }

        console.log("saved airdrop amounts csv");
    }

    async sendRefunds(fromAddress) {
        console.log("send refunds");
        const map = new Map();

        try {
            const file = await fs.readFile("data/refunds.csv", {
                encoding: "utf8",
            });
            file.split("\n").forEach((line) => {
                if (line.trim() !== "") {
                    const row = line.split(",");
                    map.set(row[0], row[1]);
                }
            });
        } catch (error) {
            console.error("Error reading CSV file:", error);
            return;
        }

        for (let [address, amount] of map) {
            try {
                const msg = MsgSend.fromJSON({
                    amount: {
                        amount: amount,
                        denom: "inj",
                    },
                    srcInjectiveAddress: fromAddress,
                    dstInjectiveAddress: address,
                });

                let result = await this.txManager.enqueue(msg);
                console.log(
                    `tx success ${result.timestamp} ${this.endpoints.explorerUrl}/transaction/${result.txHash}`
                );
            } catch (error) {
                console.error(
                    "Error processing transaction for address",
                    address,
                    ":",
                    error
                );
            }
        }
    }

    async sendAirdrop(denom) {
        console.log("sending airdrops");
        const map = new Map();

        try {
            const file = await fs.readFile("data/airdrop.csv", {
                encoding: "utf8",
            });
            file.split("\n").forEach((line) => {
                if (line.trim() !== "") {
                    const row = line.split(",");
                    map.set(row[0], row[1]);
                }
            });
        } catch (error) {
            console.error("Error reading CSV file:", error);
            return;
        }

        for (let [address, amount] of map) {
            try {
                const msg = MsgExecuteContract.fromJSON({
                    contractAddress: denom,
                    sender: this.publicKey.toBech32(),
                    msg: {
                        transfer: {
                            recipient: address,
                            amount: amount,
                        },
                    },
                });
                let result = await this.txManager.enqueue(msg);
                console.log(
                    `tx success ${result.timestamp} ${this.endpoints.explorerUrl}/transaction/${result.txHash}`.green
                );
            } catch (error) {
                console.error(
                    "Error processing transaction for address",
                    address,
                    ":",
                    error
                );
            }
        }
    }

    async createCW20Token(supply, decimals) {
        console.log(
            `deploy cw20 token with supply ${supply} and decimals ${decimals}`
        );

        const token = {
            name: "trippinj",
            symbol: "TRIPPY",
            decimals: decimals,
            initial_balances: [
                {
                    address: this.publicKey.toBech32(),
                    amount: supply.toString() + `0`.repeat(decimals),
                },
            ],
            marketing: {
                project: "trippinj on injective",
                description: "im trippin bruh",
                marketing: this.publicKey.toBech32(),
                logo: {
                    url: "https://i.ibb.co/Bfjkbyw/trippy-coin.png",
                },
            },
        };

        const msg = MsgInstantiateContract.fromJSON({
            admin: "",
            codeId: "357",
            label: "CW20 Token Deployment",
            msg: token,
            sender: this.publicKey.toBech32(),
        });

        let result = await this.txManager.enqueue(msg);
        console.log(
            `tx success ${result.timestamp} ${this.endpoints.explorerUrl}/transaction/${result.txHash}`
                .green
        );

        let attributes = result.events[result.events.length - 1].attributes;
        let address = attributes.find(
            (x) => String.fromCharCode.apply(null, x.key) == "contract_address"
        ).value;
        address = String.fromCharCode.apply(null, address).replace(/"/g, "");
        return address;
    }

    async createDojoPool(denom) {
        console.log("create pair on dojoswap");
        const msg = MsgExecuteContract.fromJSON({
            contractAddress: this.endpoints.dojoFactory,
            sender: this.publicKey.toBech32(),
            msg: {
                create_pair: {
                    assets: [
                        {
                            info: {
                                native_token: {
                                    denom: "inj",
                                },
                            },
                            amount: "0",
                        },
                        {
                            info: {
                                token: {
                                    contract_addr: denom,
                                },
                            },
                            amount: "0",
                        },
                    ],
                },
            },
        });

        const GAS = {
            ...DEFAULT_STD_FEE,
            gas: "700000",
        };

        let result = await this.txManager.enqueue(msg, GAS);
        console.log(
            `tx success ${result.timestamp} ${this.endpoints.explorerUrl}/transaction/${result.txHash}`
                .green
        );

        let attributes = result.events[result.events.length - 1].attributes;
        let address = attributes.find(
            (x) =>
                String.fromCharCode.apply(null, x.key) == "pair_contract_addr"
        ).value;
        address = String.fromCharCode.apply(null, address).replace(/"/g, "");

        let liquidityTokenAddress = attributes.find(
            (x) =>
                String.fromCharCode.apply(null, x.key) == "liquidity_token_addr"
        ).value;
        liquidityTokenAddress = String.fromCharCode
            .apply(null, liquidityTokenAddress)
            .replace(/"/g, "");

        return {
            pairAddress: address,
            liquidityTokenAddress: liquidityTokenAddress,
        };
    }

    async increaseAllowance(pairAddress, tokenDenom, amount) {
        console.log(`increase allowance of ${pairAddress} for ${tokenDenom}`);

        const msg = MsgExecuteContractCompat.fromJSON({
            sender: this.publicKey.toBech32(),
            contractAddress: tokenDenom,
            msg: {
                increase_allowance: {
                    spender: pairAddress,
                    amount: amount,
                    expires: {
                        never: {},
                    },
                },
            },
        });

        let result = await this.txManager.enqueue(msg);
        console.log(
            `tx success ${result.timestamp} ${this.endpoints.explorerUrl}/transaction/${result.txHash}`
                .green
        );
    }

    async provideLiquidity(pairAddress, tokenDenom, tokenAmount, injAmount) {
        console.log(
            `provide liquidity of ${tokenAmount} ${tokenDenom} and ${injAmount} INJ`
        );

        const msg = MsgExecuteContractCompat.fromJSON({
            sender: this.publicKey.toBech32(),
            contractAddress: pairAddress,
            msg: {
                provide_liquidity: {
                    assets: [
                        {
                            info: {
                                token: {
                                    contract_addr: tokenDenom,
                                },
                            },
                            amount: tokenAmount,
                        },
                        {
                            info: {
                                native_token: {
                                    denom: "inj",
                                },
                            },
                            amount: injAmount,
                        },
                    ],
                },
            },
            funds: { denom: "inj", amount: injAmount },
        });

        const GAS = {
            ...DEFAULT_STD_FEE,
            gas: "700000",
        };

        let result = await this.txManager.enqueue(msg, GAS);
        console.log(
            `tx success ${result.timestamp} ${this.endpoints.explorerUrl}/transaction/${result.txHash}`
                .green
        );
    }

    async queryTokenForBalance(tokenAddress) {
        try {
            const query = Buffer.from(
                JSON.stringify({ balance: { address: this.walletAddress } })
            ).toString("base64");
            const info = await this.chainGrpcWasmApi.fetchSmartContractState(
                tokenAddress,
                query
            );
            const decoded = JSON.parse(new TextDecoder().decode(info.data));
            return decoded;
        } catch (e) {
            console.log(`Error queryTokenForBalance: ${tokenAddress} ${e}`.red);
        }
        return null;
    }

    async burnLiquidity(lpTokenAddress) {
        console.log("burn liquidity");

        let balance = await this.queryTokenForBalance(lpTokenAddress);
        if (balance) balance = balance.balance;

        const msg = MsgExecuteContract.fromJSON({
            contractAddress: lpTokenAddress,
            sender: this.publicKey.toBech32(),
            msg: {
                transfer: {
                    recipient: this.dojoBurnAddress,
                    amount: balance,
                },
            },
        });

        let result = await this.txManager.enqueue(msg);
        console.log(
            `tx success ${result.timestamp} ${this.endpoints.explorerUrl}/transaction/${result.txHash}`
                .green
        );
    }
}

module.exports = InjectiveTokenTools;
