const {
    ChainGrpcWasmApi,
    IndexerGrpcAccountPortfolioApi,
    PrivateKey,
    ChainGrpcBankApi,
    MsgExecuteContractCompat,
    MsgExecuteContract,
    IndexerGrpcExplorerStream,
    IndexerRestExplorerApi,
    MsgSend
} = require('@injectivelabs/sdk-ts');
const { getNetworkEndpoints, Network } = require('@injectivelabs/networks');
const { DenomClientAsync } = require('@injectivelabs/sdk-ui-ts');
const { Client, GatewayIntentBits, ActivityType } = require('discord.js');
const { SlashCommandBuilder } = require('@discordjs/builders');
const moment = require('moment');
const fs = require('fs/promises');
const TransactionManager = require("./transactions")
const path = require('path')
var colors = require("colors");
const Astroport = require('./astroport');
const DojoSwap = require('./dojoswap');
colors.enable();
require('dotenv').config();
const { DEFAULT_STD_FEE } = require("@injectivelabs/utils");
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

class InjectiveSniper {

    constructor(config) {
        this.RPC = config.endpoints.grpc
        this.live = config.live

        console.log(`Init on ${this.RPC}`.bgGreen)

        this.chainGrpcWasmApi = new ChainGrpcWasmApi(this.RPC);

        this.astroFactory = process.env.ASTRO_FACTORY_CONTRACT;
        this.astroRouter = process.env.ASTRO_ROUTER_CONTRACT;
        this.astroPricePair = process.env.ASTRO_PRICE_PAIR_CONTRACT; // INJ / USDT

        this.dojoSwapFactory = process.env.DOJO_FACTORY_CONTRACT;
        this.dojoSwapRouter = process.env.DOJO_ROUTER_CONTRACT;
        this.dojoSwapPricePair = process.env.DOJO_PRICE_PAIR_CONTRACT;

        this.denomClient = new DenomClientAsync(Network.Mainnet, {
            endpoints: {
                grpc: this.RPC,
                indexer: "https://sentry.exchange.grpc-web.injective.network",
                rest: "https://sentry.lcd.injective.network",
                rpc: "https://sentry.tm.injective.network"
            }
        })

        this.chainGrpcBankApi = new ChainGrpcBankApi(this.RPC)
        this.indexerRestExplorerApi = new IndexerRestExplorerApi(config.endpoints.explorer)

        this.monitorNewPairs = false

        this.privateKey = PrivateKey.fromMnemonic(process.env.SNIPER_MNEMONIC)
        this.publicKey = this.privateKey.toAddress()

        this.walletAddress = this.privateKey.toAddress().toBech32()
        console.log(`Loaded wallet from private key ${this.walletAddress}`.bgGreen)

        this.txManager = new TransactionManager(this.privateKey, config.endpoints)

        this.baseAssetName = "INJ"
        this.baseDenom = "inj"
        this.baseAsset = null
        this.stableAsset = null
        this.baseAssetPrice = 0;
        this.moonBagPercent = config.moonBagPercent

        this.pairType = config.pairType
        this.tokenTypes = config.tokenTypes

        this.lowLiquidityThreshold = config.lowLiquidityThreshold
        this.highLiquidityThreshold = config.highLiquidityThreshold

        this.snipeAmount = config.snipeAmount
        this.profitGoalPercent = config.profitGoalPercent
        this.stopLoss = config.stopLoss
        this.maxSpread = config.maxSpread
        this.tradeTimeLimit = config.tradeTimeLimit
        this.positions = new Map()

        this.allPairs = new Map();
        this.ignoredPairs = new Set();

        this.pairPriceMonitoringIntervals = new Map();
        this.lowLiquidityPairMonitoringIntervals = new Map();
        this.sellPairPriceMonitoringIntervals = new Map();
        this.lastPrices = new Map();

        this.lowLiqPairsToMonitor = new Set()

        this.monitoringNewPairIntervalId = null;
        this.monitoringBasePairIntervalId = null;

        this.discordToken = process.env.DISCORD_TOKEN;
        this.discordChannelId = process.env.DISCORD_CHANNEL;

        this.discordClient = new Client({ intents: [GatewayIntentBits.Guilds] });
        this.discordTag = `<@352761566401265664>`

        this.allPairsQuery = {
            pairs: {
                start_after: [],
                limit: 50,
            },
        };
    }

    async initialize() {
        try {
            try {
                await this.loadFromFile();
                await this.updateBaseAssetPrice()

                this.astroport = new Astroport(this.chainGrpcWasmApi, this.indexerRestExplorerApi, this.baseAsset)
                this.dojoSwap = new DojoSwap(this.chainGrpcWasmApi, this.indexerRestExplorerApi, this.baseAsset)

                this.setupDiscordCommands()
            } catch (error) {
                console.error('Error during initialization:', error);
            }

            this.discordClient.on('ready', async () => {
                console.log(`Logged in as ${this.discordClient.user.tag}!`.gray);
                // await this.sendMessageToDiscord(
                //     `:arrows_clockwise: Start up INJ Sniper on RPC: ${this.RPC}\n` +
                //     `:chart_with_upwards_trend: Trading mode: ${this.live ? ':exclamation: LIVE :exclamation:' : 'TEST'}\n` +
                //     `:gun: Snipe amount: ${this.snipeAmount} ${this.baseAssetName} ($${((this.baseAssetPrice / Math.pow(10, this.stableAsset.decimals)) * this.snipeAmount).toFixed(2)}), ` +
                //     `profit goal: ${(this.profitGoalPercent).toFixed(2)}%, stop loss: ${(this.stopLoss).toFixed(2)}%,` +
                //     ` targeting pairs between $${this.lowLiquidityThreshold} and $${this.highLiquidityThreshold} in liquidity`
                // )
                // await this.sendMessageToTelegram("bot online 💡")
                this.discordClient.guilds.cache.forEach(guild => {
                    guild.commands.create(new SlashCommandBuilder()
                        .setName('get_positions')
                        .setDescription('Get portfolio positions for a wallet address')
                    );
                    guild.commands.create(new SlashCommandBuilder()
                        .setName('buy_token')
                        .addStringOption(option => option.setName('pair').setDescription('The pair to buy').setRequired(true))
                        .addNumberOption(option => option.setName('amount').setDescription('The amount to buy').setRequired(true))
                        .setDescription('Buy a token using the pair address')
                    );
                    guild.commands.create(new SlashCommandBuilder()
                        .setName('sell_token')
                        .addStringOption(option => option.setName('pair').setDescription('The pair to sell').setRequired(true))
                        .setDescription('Sell a token using the pair address')
                    );
                    guild.commands.create(new SlashCommandBuilder()
                        .setName('monitor_to_sell')
                        .addStringOption(option => option.setName('pair').setDescription('The pair to monitor').setRequired(true))
                        .setDescription('Monitor a pair for opportunity to sell')
                    );
                    guild.commands.create(new SlashCommandBuilder()
                        .setName('set_live_trading')
                        .addBooleanOption(option => option.setName('live').setDescription('Is trading live?').setRequired(true))
                        .setDescription('Set live trading mode on or off')
                    );
                    guild.commands.create(new SlashCommandBuilder()
                        .setName('set_monitor_new_pairs')
                        .addBooleanOption(option => option.setName('monitor_pairs').setDescription('Monitor for new pairs?').setRequired(true))
                        .setDescription('Set monitoring for new pairs on or off')
                    );
                    guild.commands.create(new SlashCommandBuilder()
                        .setName('start_monitor_pair_for_liquidity')
                        .addStringOption(option => option.setName('pair').setDescription('The pair to monitor').setRequired(true))
                        .setDescription('Monitor a pair for added liquidity')
                    );
                    guild.commands.create(new SlashCommandBuilder()
                        .setName('stop_monitor_pair_for_liquidity')
                        .addStringOption(option => option.setName('pair').setDescription('The pair to stop monitoring').setRequired(true))
                        .setDescription('Stop monitoring a pair for added liquidity')
                    );
                    guild.commands.create(new SlashCommandBuilder()
                        .setName('set_config')
                        .addNumberOption(option => option.setName('snipe_amount').setDescription('The snipe amount').setRequired(true))
                        .addNumberOption(option => option.setName('stop_loss').setDescription('The stop loss % 1 - 100').setRequired(true))
                        .addNumberOption(option => option.setName('profit_goal').setDescription('The profit goal % 1 - 100').setRequired(true))
                        .addNumberOption(option => option.setName('moon_bag').setDescription('The moon bag % 0.0 - 1.0').setRequired(true))
                        .addNumberOption(option => option.setName('low_liq_threshold').setDescription('The low liquidity threshold $').setRequired(true))
                        .addNumberOption(option => option.setName('high_liq_threshold').setDescription('The high liquidity threshold $').setRequired(true))
                        .addNumberOption(option => option.setName('trade_time_limit').setDescription('The trade time limit in minutes').setRequired(true))
                        .setDescription('Set the trading parameters')
                    );
                    guild.commands.create(new SlashCommandBuilder()
                        .setName('get_status')
                        .setDescription('Get the current bot status')
                    );
                });
                console.log("set up discord slash commands".gray)
            });
            this.discordClient.login(this.discordToken);
        } catch (error) {
            console.error('Error during initialization:', error);
        }
    }

    async getBalanceOfToken(denom) {
        return await this.chainGrpcBankApi.fetchBalance({
            accountAddress: this.walletAddress,
            denom,
        })
    }

    async queryTokenForBalance(tokenAddress) {
        try {
            const query = Buffer.from(JSON.stringify({ balance: { address: this.walletAddress } })).toString('base64');
            const info = await this.chainGrpcWasmApi.fetchSmartContractState(tokenAddress, query);
            const decoded = JSON.parse(new TextDecoder().decode(info.data));
            console.log(decoded)
            return decoded
        }
        catch (e) {
            console.log(`Error queryTokenForBalance: ${tokenAddress} ${e}`.red)
        }
        return null
    }

    setupDiscordCommands() {
        this.discordClient.on('interactionCreate', async interaction => {
            if (!interaction.isCommand()) return;
            const { commandName } = interaction;
            if (commandName === 'get_positions') {
                await interaction.reply("Fetching wallet holdings...");
                await this.executeGetPositionsCommand();
            }
            if (commandName === 'buy_token') {
                await interaction.reply("Buying token");
                const pairContract = interaction.options.getString('pair');
                const amount = interaction.options.getNumber('amount');
                await this.executeBuyCommand(pairContract, amount);
            }
            if (commandName === 'sell_token') {
                await interaction.reply("Selling token");
                const pairContract = interaction.options.getString('pair');
                await this.executeSellCommand(pairContract);
            }
            if (commandName === 'monitor_to_sell') {
                await interaction.reply("Monitoring token to sell");
                const pairContract = interaction.options.getString('pair');
                await this.executeMonitorToSellCommand(pairContract);
            }
            if (commandName === 'set_live_trading') {
                const live = interaction.options.getBoolean('live');
                this.live = live
                await interaction.reply(`Set live trading to ${live}`);
            }
            if (commandName === 'set_monitor_new_pairs') {
                const monitor_pairs = interaction.options.getBoolean('monitor_pairs');
                this.setMonitorNewPairs(monitor_pairs)
                await interaction.reply(`Set monitor new pairs to ${monitor_pairs}`);
            }
            if (commandName === 'start_monitor_pair_for_liquidity') {
                await interaction.reply(`OK`);
                const pairContract = interaction.options.getString('pair');
                this.startMonitorPairForLiq(pairContract)
                let pair = await this.getPairInfo(pairContract)
                const pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`;
                // await interaction.reply(`:arrow_forward: Began monitoring ${pairName} for liquidity`);
            }
            if (commandName === 'stop_monitor_pair_for_liquidity') {
                const pairContract = interaction.options.getString('pair');
                this.stopMonitorPairForLiq(pairContract)
                let pair = await this.getPairInfo(pairContract)
                const pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`;
                await interaction.reply(`:stop_button: Stopped monitoring ${pairName} for liquidity`);
            }
            if (commandName === 'set_config') {
                const snipeAmount = interaction.options.getNumber('snipe_amount');
                const profitGoal = interaction.options.getNumber('stop_loss');
                const stopLoss = interaction.options.getNumber('profit_goal');
                const moonBagPercent = interaction.options.getNumber('moon_bag');
                const lowLiq = interaction.options.getNumber('low_liq_threshold');
                const highLiq = interaction.options.getNumber('high_liq_threshold');
                const timeLimit = interaction.options.getNumber('trade_time_limit');

                this.snipeAmount = snipeAmount
                this.profitGoalPercent = profitGoal
                this.stopLoss = stopLoss
                this.moonBagPercent = moonBagPercent
                this.lowLiquidityThreshold = lowLiq
                this.highLiquidityThreshold = highLiq
                this.tradeTimeLimit = timeLimit

                let message =
                    `:gun: Snipe amount: ${this.snipeAmount} ${this.baseAssetName} ($${((this.baseAssetPrice / Math.pow(10, this.stableAsset.decimals)) * this.snipeAmount).toFixed(2)})\n` +
                    `:moneybag: Profit goal: ${this.profitGoalPercent}% :octagonal_sign: Stop loss: ${this.stopLoss}% :crescent_moon: Moon bag: ${this.moonBagPercent}\n` +
                    `:arrow_down_small: Low liquidity threshold: $${this.lowLiquidityThreshold} :arrow_up_small: High liquidity threshold: $${this.highLiquidityThreshold}\n` +
                    `:alarm_clock: Time limit: ${this.tradeTimeLimit} mins\n\n` +
                    `Trading live: ${this.live ? ":white_check_mark:" : ":x:"}\n` +
                    `Monitoring new pairs: ${this.monitorNewPairs ? ":white_check_mark:" : ":x:"}\n`

                await interaction.reply(message);
            }
            if (commandName === 'get_status') {
                let liqMonitor = ""
                for (const pair of this.lowLiqPairsToMonitor.values()) {
                    let pairInfo = await this.getPairInfo(pair)
                    let pairName = `${pairInfo.token0Meta.symbol}, ${pairInfo.token1Meta.symbol}`;
                    liqMonitor += `${pairName} (${pair}), `
                }

                let message =
                    `:gun: Snipe amount: ${this.snipeAmount} ${this.baseAssetName} ($${((this.baseAssetPrice / Math.pow(10, this.stableAsset.decimals)) * this.snipeAmount).toFixed(2)})\n` +
                    `:moneybag: Profit goal: ${this.profitGoalPercent}% :octagonal_sign: Stop loss: ${this.stopLoss}% :crescent_moon: Moon bag: ${this.moonBagPercent}\n` +
                    `:arrow_down_small: Low liquidity threshold: $${this.lowLiquidityThreshold} :arrow_up_small: High liquidity threshold: $${this.highLiquidityThreshold}\n` +
                    `:alarm_clock: Time limit: ${this.tradeTimeLimit} mins\n\n` +
                    `Trading live: ${this.live ? ":white_check_mark:" : ":x:"}\n` +
                    `Monitoring new pairs: ${this.monitorNewPairs ? ":white_check_mark:" : ":x:"}\n` +
                    `Monitoring pairs for liquidity: ${liqMonitor.length > 0 ? liqMonitor : "none"}\n`

                await interaction.reply(message);
            }
        });
    }

    async executeGetPositionsCommand() {
        try {
            const walletAddress = this.walletAddress;
            const portfolio = await this.getPortfolio(walletAddress);
            const message = `**Current holdings for ${walletAddress}**\n${await this.formatPortfolioMessage(portfolio)}`;
            await this.sendMessageToDiscord(message)
        } catch (error) {
            console.error('Error executing /get_positions command:', error);
            await this.sendMessageToDiscord('Error executing /get_positions command')
        }
    }

    async executeBuyCommand(pairContract, amount) {
        try {
            let pair = await this.getPairInfo(pairContract)
            if (!pair) {
                this.sendMessageToDiscord(`Could not get pair`)
                return
            }
            await this.calculateLiquidity(pair)
            // if (pair.liquidity < this.lowLiquidityThreshold) {
            //     this.monitorLowLiquidityPair(pair, 5, this.lowLiquidityThreshold)
            //     await this.sendMessageToDiscord(`:eyes: Monitoring token for liquidity change`)
            //     return
            // }
            let result = await this.buyMemeToken(pair, amount)
            if (result && !this.allPairs.has(pairContract)) {
                this.allPairs.set(pairContract, pair);
                this.ignoredPairs.delete(pairContract);
            }
        } catch (error) {
            console.error('Error executing /buy_token command:', error);
            await this.sendMessageToDiscord('Error executing /buy_token command')
        }
    }

    async executeSellCommand(pairContract) {
        try {
            let pair = await this.getPairInfo(pairContract)

            const memeTokenMeta = pair.token0Meta.denom === this.baseDenom
                ? pair.token1Meta
                : pair.token0Meta;

            let balance = await this.getBalanceOfToken(memeTokenMeta.denom);
            console.log(balance)

            if (!balance || Number(balance.amount) <= 0) {
                balance = await this.queryTokenForBalance(memeTokenMeta.denom)
                if (balance) {
                    balance = balance.balance
                }
            }
            else {
                balance = balance.amount
            }

            if (balance) {
                let result = await this.sellMemeToken(pair, balance)
                if (result && !this.allPairs.has(pairContract)) {
                    this.allPairs.set(pairContract, pair);
                    this.ignoredPairs.delete(pairContract);
                }
            }

        } catch (error) {
            console.error('Error executing /sell_token command:', error);
            await this.sendMessageToDiscord('Error executing /sell_token command')
        }
    }

    async executeMonitorToSellCommand(pairContract) {
        try {
            let pair = await this.getPairInfo(pairContract)
            await this.monitorPairToSell(pair, 5)
            if (pair && !this.allPairs.has(pairContract)) {
                this.allPairs.set(pairContract, pair);
                this.ignoredPairs.delete(pairContract);
            }
        } catch (error) {
            console.error('Error executing /monitor_to_sell command:', error);
            await this.sendMessageToDiscord('Error executing /monitor_to_sell command')
        }
    }

    async loadFromFile() {
        try {
            this.allPairs = await this.loadMapFromFile('allPairs.json', 'contract_addr');
            this.positions = await this.loadMapFromFile('positions.json', 'pair_contract');
            this.ignoredPairs = await this.loadSetFromFile('ignoredPairs.json');

            console.log('Loaded data from files'.gray);
        } catch (error) {
            console.error('Error loading data from files:', error);
        }
    }

    async loadMapFromFile(filename, keyProperty) {
        const pairs = await this.readDataFromFile(filename);
        return new Map(pairs.map(item => [item[keyProperty], item]));
    }

    async loadSetFromFile(filename) {
        const items = await this.readDataFromFile(filename);
        return new Set(items);
    }

    async saveToFile() {
        try {
            await this.saveDataToFile('allPairs.json', Array.from(this.allPairs.values()));
            await this.saveDataToFile('positions.json', Array.from(this.positions.values()));
            await this.saveDataToFile('ignoredPairs.json', Array.from(this.ignoredPairs));

        } catch (error) {
            console.error('Error saving data to files:', error);
        }
    }

    async readDataFromFile(filename) {
        const filePath = path.resolve(__dirname, '..', 'data', filename);
        try {
            const data = await fs.readFile(filePath, 'utf-8');
            return JSON.parse(data);
        } catch (error) {
            return filename === 'positions.json' || filename === 'allPairs.json' ? new Map() : new Set();
        }
    }

    async saveDataToFile(filename, data) {
        const filePath = path.resolve(__dirname, '..', 'data', filename);

        try {
            await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
        } catch (error) {
            console.error(`Error saving ${filename} to file:`, error);
        }
    }

    async sendMessageToDiscord(message) {
        if (!this.discordClient || !this.discordChannelId) {
            console.error('Discord client or channel information not available.');
            return;
        }

        const channel = this.discordClient.channels.cache.get(this.discordChannelId);
        if (!channel) {
            console.error('Discord channel not found.');
            return;
        }

        try {
            await channel.send(message);
        } catch (error) {
            console.error('Error sending message to Discord channel:', error);
        }
    }

    async sendMessageToTelegram(message) {
        const token = process.env.TG_BOT_TOKEN
        const chatId = process.env.TG_CHAT_ID
        const url = `https://api.telegram.org/bot${token}/sendMessage`;
        console.log(url)

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                chat_id: chatId,
                text: message,
            }),
        });

        const data = await response.json();
        console.log(data);
    }

    async updateBaseAssetPrice() {
        let baseAssetPair = await this.getPairInfo(this.dojoSwapPricePair)

        this.allPairs.set(this.dojoSwapPricePair, baseAssetPair)
        let quote = await this.getQuote(baseAssetPair, 1)
        if (!quote) return

        this.baseAssetPrice = Number(quote['return_amount'])
        this.stableAsset = baseAssetPair.token1Meta
        this.baseAsset = baseAssetPair.token0Meta

        const currentPrice = quote['return_amount'] / Math.pow(10, this.stableAsset.decimals)

        if (this.discordClient && this.discordClient.user) {
            const activityText = `${this.baseAssetName}: $${currentPrice.toFixed(2)}`;
            this.discordClient.user.setActivity(activityText, { type: ActivityType.Watching });
        }

        await this.saveToFile()
    }

    startMonitoringBasePair(intervalInSeconds) {
        console.log('Base Asset monitoring started.'.gray);
        this.monitoringBasePairIntervalId = setInterval(async () => {
            await this.updateBaseAssetPrice();
        }, intervalInSeconds * 1000);
    }

    stopMonitoringBasePair() {
        clearInterval(this.monitoringBasePairIntervalId);
        console.log('Base Asset monitoring stopped.');
    }

    async getDenomMetadata(denom) {
        try {
            const token = await this.denomClient.getDenomToken(denom)
            return token;
        } catch (error) {
            console.error('Error fetching token info:', error);
            return {}
        }
    }

    async getTokenInfo(denom) {
        try {
            let query = Buffer.from(JSON.stringify({ token_info: {} })).toString('base64')
            const token = await this.chainGrpcWasmApi.fetchSmartContractState(denom, query)
            return JSON.parse(new TextDecoder().decode(token.data));
        } catch (error) {
            console.error('Error fetching token info:', denom, error.message || error);
            return {}
        }
    }

    async getContractHistory(pairContract) {
        const contractHistory = await this.chainGrpcWasmApi.fetchContractHistory(
            pairContract
        )
        console.log(contractHistory)
        contractHistory.entriesList.map((item) => {
            console.log(new TextDecoder().decode(item.msg))
        })
    }

    async checkHasPair(factory, assetInfos) {
        try {
            const factoryQuery = Buffer.from(JSON.stringify({ pair: { asset_infos: assetInfos } })).toString('base64');
            const factoryInfo = await this.chainGrpcWasmApi.fetchSmartContractState(factory, factoryQuery);
            const factoryDecoded = JSON.parse(new TextDecoder().decode(factoryInfo.data));
            return factoryDecoded
        }
        catch (e) {
            console.log(`Error checking factory for pair: ${JSON.stringify(assetInfos, null, 2)} ${e}`.red)
        }
        return null
    }

    async getPairInfo(pairContract) {
        let retryCount = 0;

        while (retryCount < 2) {
            try {
                const pairQuery = Buffer.from(JSON.stringify({ pair: {} })).toString('base64');
                const pairInfo = await this.chainGrpcWasmApi.fetchSmartContractState(pairContract, pairQuery);
                const infoDecoded = JSON.parse(new TextDecoder().decode(pairInfo.data));
                const assetInfos = infoDecoded['asset_infos'];
                const tokenInfos = [];

                let factory
                try {
                    let p = await this.checkHasPair(this.astroFactory, assetInfos)
                    if (p !== null) factory = this.astroFactory

                    p = await this.checkHasPair(this.dojoSwapFactory, assetInfos)
                    if (p !== null) factory = this.dojoSwapFactory

                }
                catch (e) {
                    console.log(e)
                    console.log(`could not query pair config, setting to astro factory`.gray)
                    factory = this.astroFactory
                }

                for (const assetInfo of assetInfos) {
                    const denom = assetInfo['native_token']
                        ? assetInfo['native_token']['denom']
                        : assetInfo['token']['contract_addr'];

                    let tokenInfo = {}

                    if (
                        denom === this.baseDenom
                        || denom.includes("factory")
                        || denom.includes("peggy")
                        || denom.includes("ibc")
                    ) {
                        tokenInfo = await this.getDenomMetadata(denom)
                        if (denom.includes("factory") && !tokenInfo['name']) {
                            let name = denom.split("/")[2]
                            tokenInfo['name'] = name
                            tokenInfo['symbol'] = name
                        }

                    }
                    else {
                        tokenInfo = await this.getTokenInfo(denom);
                    }
                    tokenInfos.push({
                        denom: denom,
                        name: 'n/a',
                        symbol: 'n/a',
                        decimals: 6, // guess the token decimals
                        tokenType: denom.includes("factory") ? "tokenFactory" : "cw20",
                        ...tokenInfo,
                    });
                }
                if (tokenInfos.length !== 2) return null
                const [token0Info, token1Info] = tokenInfos;

                return {
                    token0Meta: token0Info,
                    token1Meta: token1Info,
                    astroportLink: `https://app.astroport.fi/swap?from=${token0Info.denom}&to=${token1Info.denom}`,
                    coinhallLink: `https://coinhall.org/injective/${pairContract}?trader=${this.walletAddress}`,
                    dexscreenerLink: `https://dexscreener.com/injective/${pairContract}?maker=${this.walletAddress}`,
                    dojoSwapLink: `https://dojo.trading/swap?type=swap&from=${token0Info.denom}&to=${token1Info.denom}`,
                    factory: factory,
                    ...infoDecoded
                };

            } catch (error) {
                if (error.name == "GrpcUnaryRequestException") {
                    console.log(error)
                    console.error(`Error fetching pair ${pairContract} info. Retrying... (Retry count: ${retryCount + 1})`);
                    retryCount++;
                } else {
                    console.error(`Error fetching pair ${pairContract} info:`, error);
                    break;
                }
            }
        }
        console.error(`Max retry count reached. Unable to fetch pair ${pairContract} info.`);
        return null;
    }

    async getQuote(pair, amount) {
        if (!pair) return
        const offerAmount = amount * Math.pow(10, this.baseAsset ? this.baseAsset.decimals : 18);
        const pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`;
        const simulationQuery = {
            simulation: {
                offer_asset: {
                    info: {
                        native_token: {
                            denom: 'inj'
                        }
                    },
                    amount: offerAmount.toString()
                }
            }
        };
        try {
            const query = Buffer.from(JSON.stringify(simulationQuery)).toString('base64');
            const sim = await this.chainGrpcWasmApi.fetchSmartContractState(pair.contract_addr, query);

            const decodedData = JSON.parse(new TextDecoder().decode(sim.data));
            return decodedData;
        } catch (error) {
            console.error(`Error getting quote for ${pairName}: ${error}`);
        }
    }

    async getQuoteFromRouter(pair, amount) {
        if (!pair.factory) {
            console.error(`pair has no factory`.red)
            return
        }
        if (pair.factory === this.astroFactory) {
            return await this.astroport.getQuoteFromRouter(pair, amount)
        }
        if (pair.factory === this.dojoSwapFactory) {
            return await this.dojoSwap.getQuoteFromRouter(pair, amount)
        }
    }

    async getSellQuoteFromRouter(pair, amount) {
        if (pair.factory === this.astroFactory) {
            return await this.astroport.getSellQuoteFromRouter(pair, amount)
        }
        if (pair.factory === this.dojoSwapFactory) {
            return await this.dojoSwap.getSellQuoteFromRouter(pair, amount)
        }
    }

    async getQuotes(pairs) {
        pairs.forEach(async (pair) => {
            let pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`
            let decodedData = await this.getQuote(pair, 1)
            if (decodedData) {
                console.log(`quote for ${pairName}: ${this.baseAssetPrice / decodedData['return_amount']}`)
            }
        })
    }

    async calculateLiquidity(pair) {
        if (!pair) return
        try {
            const poolQuery = Buffer.from(JSON.stringify({ pool: {} })).toString('base64');
            let poolInfo = await this.chainGrpcWasmApi.fetchSmartContractState(pair.contract_addr, poolQuery)
            let poolDecoded = JSON.parse(new TextDecoder().decode(poolInfo.data))

            const baseAssetAmount = poolDecoded.assets.find(asset => {
                if (asset.info.native_token) {
                    return asset.info.native_token.denom === this.baseAsset.denom;
                } else if (asset.info.token) {
                    return asset.info.token.contract_addr === this.baseAsset.denom;
                }
                return false;
            })?.amount || 0;
            const baseAssetDecimals = this.baseAsset.decimals || 0;
            const baseAssetPrice = this.baseAssetPrice || 0;

            const numericBaseAssetAmount = Number(baseAssetAmount) / 10 ** baseAssetDecimals;
            let liquidity = numericBaseAssetAmount * baseAssetPrice;
            liquidity = (liquidity * 2) / Math.pow(10, this.stableAsset.decimals)
            pair.liquidity = liquidity
            pair.liquidityUpdate = moment()
            return liquidity;
        } catch (error) {
            console.error('Error calculating liquidity:', error.originalMessage ?? error);
            return null;
        }
    }

    async monitorPairForPriceChange(pair, intervalInSeconds, trackingDurationMinutes, priceChangeThreshold) {
        try {
            let pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`;
            if (this.pairPriceMonitoringIntervals.has(pair.contract_addr)) {
                console.log(`Pair ${pairName} is already being monitored.`);
                return;
            }

            let lastPrices = this.lastPrices.get(pair.contract_addr) || [];

            const monitoringIntervalId = setInterval(async () => {
                const quote = await this.getQuoteFromRouter(pair, 1);
                if (!quote) return

                const decimals = pair.token0Meta.denom == this.baseDenom ? pair.token1Meta.decimals : pair.token0Meta.decimals

                let baseAssetPriceAdjusted = this.baseAssetPrice / Math.pow(10, this.stableAsset.decimals)
                let quoteAdjusted = Number(quote['amount']) / Math.pow(10, decimals)

                const currentPrice = baseAssetPriceAdjusted / quoteAdjusted

                lastPrices.push(currentPrice);
                lastPrices = lastPrices.slice(-trackingDurationMinutes * 60 / intervalInSeconds);

                const newHighestPrice = Math.max(...lastPrices, 0);
                const newLowestPrice = Math.min(...lastPrices, Infinity);

                const priceChangeToHighest = ((currentPrice - newHighestPrice) / newHighestPrice) * 100;
                const priceChangeToLowest = ((currentPrice - newLowestPrice) / newLowestPrice) * 100;

                await this.calculateLiquidity(pair)

                if (pair.liquidity < 0.01) {
                    let message = `:small_red_triangle_down: ${pairName} rugged!`
                    this.sendMessageToDiscord(message);
                }
                else {
                    if (Math.abs(priceChangeToHighest) > priceChangeThreshold) {
                        let message = `:small_red_triangle_down: ${pairName} Price is down ${parseFloat(priceChangeToHighest).toFixed(2)}% in the last ` +
                            `${trackingDurationMinutes} minutes. current: $${parseFloat(currentPrice).toFixed(10)}, ` +
                            `high: $${newHighestPrice.toFixed(10)}, liquidity: $${Math.round(pair.liquidity)}\n` +
                            `${pair.coinhallLink}\n${pair.astroportLink}`
                        this.sendMessageToDiscord(message);
                        this.lastPrices.delete(pair.contract_addr);
                        lastPrices = [];
                    }

                    if (priceChangeToLowest > priceChangeThreshold) {
                        let message = `:green_circle: ${pairName} price is up ${parseFloat(priceChangeToLowest).toFixed(2)}% in the last ` +
                            `${trackingDurationMinutes} minutes. current: $${parseFloat(currentPrice).toFixed(10)}, ` +
                            `low: $${newLowestPrice.toFixed(10)}, liquidity: $${Math.round(pair.liquidity)}\n` +
                            `${pair.coinhallLink}\n${pair.astroportLink}`;
                        this.sendMessageToDiscord(message);
                        this.lastPrices.delete(pair.contract_addr);
                        lastPrices = [];
                    }
                }


                console.log(`${pairName} price ${parseFloat(currentPrice).toFixed(10)}, liquidity: $${Math.round(pair.liquidity)}`.yellow)

                if (currentPrice == Infinity || pair.liquidity < 1) {
                    this.stopMonitoringPairForPriceChange(pair)
                }
            }, intervalInSeconds * 1000);

            this.pairPriceMonitoringIntervals.set(pair.contract_addr, monitoringIntervalId);

            console.log(`Price - Monitoring started for ${pairName}.`.bgCyan);
        } catch (error) {
            console.error('Error monitoring pair:', error);
        }
    }

    stopMonitoringPairForPriceChange(pair) {
        let pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`
        if (this.pairPriceMonitoringIntervals.has(pair.contract_addr)) {
            clearInterval(this.pairPriceMonitoringIntervals.get(pair.contract_addr));
            this.pairPriceMonitoringIntervals.delete(pair.contract_addr);

            console.log(`Monitoring stopped for ${pairName}.`.bgYellow);
        } else {
            console.log(`Pair ${pairName} is not being monitored.`);
        }
    }

    async monitorLowLiquidityPair(pair, intervalInSeconds, liquidityThreshold) {
        try {
            const pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`;
            if (this.lowLiquidityPairMonitoringIntervals.has(pair.contract_addr)) {
                console.log(`Pair ${pairName} is already being monitored for low liquidity.`);
                return;
            }
            const monitoringIntervalId = setInterval(async () => {
                const updatedPair = await this.getPairInfo(pair.contract_addr);
                if (!updatedPair) return
                this.allPairs.set(pair.contract_addr, updatedPair)
                const currentLiquidity = await this.calculateLiquidity(updatedPair);
                console.log(`${pairName} liquidity: ${currentLiquidity}`.gray)
                if (currentLiquidity && currentLiquidity > liquidityThreshold && this.live) {
                    this.stopMonitoringLowLiquidityPair(pair)
                    console.log(`Monitoring ${pairName} - Liquidity Added: $${currentLiquidity}`);
                    this.sendMessageToDiscord(`:eyes: ${pairName} - Liquidity Added: $${currentLiquidity}\n${pair.astroportLink}\n${pair.dexscreenerLink}\n<@352761566401265664>`)
                    await this.buyMemeToken(pair, this.snipeAmount)
                }
            }, intervalInSeconds * 1000);
            this.lowLiquidityPairMonitoringIntervals.set(pair.contract_addr, monitoringIntervalId);
            console.log(`Low Liquidity - Monitoring started for ${pairName}`.bgCyan);

        } catch (error) {
            console.error('Error monitoring low liquidity pair:', error);
        }
    }

    stopMonitoringLowLiquidityPair(pair) {
        const pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`;
        const monitoringIntervalId = this.lowLiquidityPairMonitoringIntervals.get(pair.contract_addr);

        if (monitoringIntervalId) {
            clearInterval(monitoringIntervalId);
            this.lowLiquidityPairMonitoringIntervals.delete(pair.contract_addr);
            console.log(`Monitoring stopped for ${pairName} - Low Liquidity.`.bgYellow);
        } else {
            console.log(`Pair ${pairName} is not currently being monitored for low liquidity.`);
        }
    }

    async getPortfolio() {

        try {
            const endpoints = getNetworkEndpoints(Network.Mainnet);
            const indexerGrpcAccountPortfolioApi = new IndexerGrpcAccountPortfolioApi(
                endpoints.indexer,
            );

            const portfolio = await indexerGrpcAccountPortfolioApi.fetchAccountPortfolio(
                this.walletAddress,
            );
            for (const balance of portfolio.bankBalancesList) {
                try {
                    if (balance.denom === this.baseDenom || balance.amount <= 0) continue;

                    const pair = Array.from(this.allPairs.values()).find(pair => {
                        return (
                            (pair && pair.token0Meta.denom === balance.denom) ||
                            (pair && pair.token1Meta.denom === balance.denom)
                        );
                    });

                    if (!pair) continue;

                    const pairInfo = await this.getPairInfo(pair.contract_addr);
                    if (!pairInfo) continue
                    await this.calculateLiquidity(pairInfo)
                    if (pairInfo) {
                        this.allPairs.set(pair.contract_addr, pairInfo)
                        const pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`;
                        const tokenDenom = pair.asset_infos[0].native_token.denom === balance.denom
                            ? pair.token0Meta
                            : pair.token1Meta;

                        const quote = await this.getSellQuoteFromRouter(pair, balance.amount);

                        if (quote) {
                            const amountBack = (quote.amount / Math.pow(10, this.baseAsset.decimals)).toFixed(3);
                            const convertedQuote = quote.amount / Math.pow(10, this.baseAsset.decimals)
                            const baseAssetPriceConverted = this.baseAssetPrice / Math.pow(10, this.stableAsset.decimals)
                            const usdValue = (convertedQuote * baseAssetPriceConverted)

                            if (!this.positions.has(pair.contract_addr)) {
                                this.positions.set(
                                    pair.contract_addr,
                                    {
                                        pair_contract: pair.contract_addr,
                                        balance: balance.amount,
                                        amount_in: 0,
                                        token_denom: tokenDenom.denom,
                                        profit: 0,
                                        is_moon_bag: true
                                    });
                            }

                            console.log(`found balance for ${pairName}: ${(balance.amount / Math.pow(10, tokenDenom.decimals)).toFixed(2)} ${tokenDenom.symbol} (${amountBack} ${this.baseAssetName} $${usdValue.toFixed(2)})`.yellow)

                        }
                    }
                } catch (error) {
                    console.error(`Error processing balance for ${balance.denom}:`, error.originalMessage ?? error);
                }
            }
            return portfolio
        } catch (error) {
            console.error('Error fetching account portfolio:', error);
        }
    }

    async updateLiquidityAllPairs() {
        console.log("update liquidity for all pairs".bgCyan)
        for (const pair of this.allPairs.values()) {
            await this.calculateLiquidity(pair);
            if (pair.liquidity < 10 && pair.liquidity > 0 && !this.positions.has(pair.contract_addr)) {
                this.allPairs.delete(pair.contract_addr)
                this.ignoredPairs.add(pair.contract_addr)
            }
        }
        await this.saveToFile()
    }

    async buyMemeToken(pair, amount, retries = 5) {
        if (!pair) {
            console.error("Invalid pair");
            return;
        }

        const { token0Meta, token1Meta } = pair;
        const baseTokenMeta = token0Meta.denom === this.baseDenom ? token0Meta : token1Meta;
        const memeTokenMeta = token0Meta.denom === this.baseDenom ? token1Meta : token0Meta;

        console.log(`Attempting to buy ${memeTokenMeta.symbol}`);

        const adjustedAmount = amount * 10 ** (this.baseAsset ? this.baseAsset.decimals : 18);

        const swapOperations = {
            swap: {
                offer_asset: {
                    info: {
                        native_token: {
                            denom: baseTokenMeta.denom,
                        },
                    },
                    amount: adjustedAmount.toString(),
                },
                max_spread: this.maxSpread.toString(),
            },
        };

        const msg = MsgExecuteContractCompat.fromJSON({
            contractAddress: pair.contract_addr,
            sender: this.walletAddress,
            msg: swapOperations,
            funds: {
                denom: this.baseDenom,
                amount: adjustedAmount,
            },
        });

        const GAS = {
            ...DEFAULT_STD_FEE,
            amount: [{ amount: '200000000000000', denom: 'inj' }],
            gas: "600000",
        };

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const result = await this.txManager.enqueue(msg, GAS);
                if (result) {
                    console.log("Swap executed successfully:", result.txHash);

                    console.log(result)

                    const returnAmount = this.parseReturnAmountFromEvents(result.events);

                    if (returnAmount !== undefined) {
                        this.handleSuccessfulSwap(pair, returnAmount, adjustedAmount, memeTokenMeta, result.txHash);
                        // await this.monitorPairToSell(pair, 10);
                    } else {
                        console.error("Return amount not found in events.");
                    }

                    return result;
                }
                console.log(`Buy attempt ${attempt} failed. Retrying...`);
            } catch (error) {
                console.error(`Error executing swap (attempt ${attempt}):`, error);
            }
        }

        console.error(`Failed to execute swap after ${retries} attempts.`);
        this.sendMessageToDiscord(`Failed to execute swap after ${retries} attempts.`)
    }

    parseReturnAmountFromEvents(events) {
        if (!events) return undefined;
        const wasmEvents = events.filter((event) => event.type === "wasm");
        if (wasmEvents.length < 1) return undefined;

        for (const wasmEvent of wasmEvents) {
            console.log(wasmEvent);
            const returnAmountAttribute = wasmEvent.attributes.find((attr) => {
                const key = new TextDecoder().decode(attr.key);
                return key === "return_amount";
            });

            if (returnAmountAttribute) {
                const value = new TextDecoder().decode(returnAmountAttribute.value);
                return value;
            }
        }

        return undefined;
    }


    handleSuccessfulSwap(pair, returnAmount, adjustedAmount, memeTokenMeta, txHash) {
        const balance = this.positions.get(pair.contract_addr)?.balance || 0;
        const profit = this.positions.get(pair.contract_addr)?.profit || 0;
        const amountIn = this.positions.get(pair.contract_addr)?.amount_in || 0;

        console.log(`${memeTokenMeta.denom} existing balance ${balance}`)
        const updatedBalance = Number(balance) + Number(returnAmount);
        console.log(`${memeTokenMeta.denom} updated balance ${updatedBalance}`)

        this.positions.set(pair.contract_addr, {
            pair_contract: pair.contract_addr,
            balance: updatedBalance,
            amount_in: Number(amountIn) + Number(adjustedAmount),
            token_denom: memeTokenMeta.denom,
            time_bought: moment(),
            profit: profit,
            is_moon_bag: false
        });

        console.log(this.positions.get(pair.contract_addr))

        let dex = ""
        if (pair.factory == this.astroFactory) {
            dex = "Astroport"
        }
        if (pair.factory == this.dojoSwapFactory) {
            dex = "DojoSwap"
        }

        this.sendMessageToDiscord(
            `:gun: Sniped token ${memeTokenMeta.symbol} from ${dex}! ` +
            `Balance: ${(updatedBalance / 10 ** memeTokenMeta.decimals).toFixed(3)} ` +
            `<@352761566401265664>\n${pair.coinhallLink}` +
            `\ntx: https://explorer.injective.network/transaction/${txHash}`
        );
    }

    async sellMemeToken(pair, amount = null, maxRetries = 3) {
        if (!pair) {
            console.error("Invalid pair for sellMemeToken");
            return;
        }

        // if (!this.live) {
        //     console.error("Live trading not enabled");
        //     return;
        // }

        const memeTokenMeta = pair.token0Meta.denom === this.baseDenom
            ? pair.token1Meta
            : pair.token0Meta;

        const memeAssetInfo = pair.token0Meta.denom === this.baseDenom
            ? pair.asset_infos[1]
            : pair.asset_infos[0]

        let position = this.positions.get(pair.contract_addr);

        if (!amount) {
            if (position) {
                console.log("get balance from positions")
                amount = this.positions.get(pair.contract_addr).balance;
            } else {
                console.log("get balance from bank")
                amount = await this.getBalanceOfToken(memeTokenMeta.denom).amount;
            }
        }

        if (!amount) {
            console.log(`No balance to sell for ${memeTokenMeta.symbol}`)
            return
        }

        if (amount.toString().includes('.')) {
            amount = Math.round(Number(amount))
        }

        let spread = this.maxSpread

        const GAS = {
            ...DEFAULT_STD_FEE,
            amount: [{ amount: '200000000000000', denom: 'inj' }],
            gas: "600000",
        };

        let retryCount = 0;
        while (retryCount < maxRetries) {

            let swapOperations = {
                swap: {
                    offer_asset: {
                        info: memeAssetInfo,
                        amount: amount.toLocaleString('fullwide', { useGrouping: false })
                    },
                    max_spread: spread.toString(),
                },
            };

            let msg = MsgExecuteContractCompat.fromJSON({
                contractAddress: pair.contract_addr,
                sender: this.walletAddress,
                msg: swapOperations,
                funds: {
                    denom: memeTokenMeta.denom,
                    amount: amount.toLocaleString('fullwide', { useGrouping: false })
                },
            });

            if (pair.factory == this.dojoSwapFactory) {
                swapOperations = {
                    send: {
                        contract: pair.contract_addr,
                        amount: amount.toLocaleString('fullwide', { useGrouping: false }),
                        msg: Buffer.from(JSON.stringify({ swap: {} })).toString('base64')
                    },
                };
                msg = MsgExecuteContractCompat.fromJSON({
                    contractAddress: memeTokenMeta.denom,
                    sender: this.walletAddress,
                    msg: swapOperations,
                });
            }

            try {
                let result = await this.txManager.enqueue(msg, GAS);

                if (!result) {
                    console.log("Sell failed");
                    retryCount += 1;
                    spread += 0.2

                    if (!amount) {
                        console.log("refreshing balance, attempting sell again")
                        amount = await this.getBalanceOfToken(memeTokenMeta.denom).amount;
                        amount = Math.round(amount)
                    }

                    amount = Math.round(Number(amount - (amount * 0.1)))
                    console.log(`change amount to ${amount}`.bgCyan)
                }
                else {
                    this.stopMonitoringPairToSell(pair)

                    console.log("Swap executed successfully:", result.txHash);

                    let profit = 0
                    const returnAmount = this.parseReturnAmountFromEvents(result.events);
                    if (returnAmount !== undefined) {
                        profit = returnAmount - position.amount_in
                    } else {
                        console.error("Return amount not found in sell events.");
                    }

                    let updatedBalance = Number(position.balance) - Number(amount)
                    let updatedAmountIn = Number(position.amount_in) - Number(returnAmount)
                    if (updatedAmountIn < 0) {
                        updatedAmountIn = 0
                    }

                    this.positions.set(pair.contract_addr, {
                        ...position,
                        amount_in: updatedAmountIn,
                        balance: updatedBalance,
                        profit: Number(position.profit) + Number(profit),
                        is_moon_bag: updatedBalance > 0 && updatedAmountIn == 0
                    });

                    profit = (profit / Math.pow(10, this.baseAsset.decimals))
                    let returnAmountAdjusted = (returnAmount / Math.pow(10, this.baseAsset.decimals))

                    const baseAssetPriceConverted = this.baseAssetPrice / Math.pow(10, this.stableAsset.decimals)
                    const usdValue = (profit * baseAssetPriceConverted)

                    let dex = ""
                    if (pair.factory == this.astroFactory) {
                        dex = "Astroport"
                    }
                    if (pair.factory == this.dojoSwapFactory) {
                        dex = "DojoSwap"
                    }

                    this.sendMessageToDiscord(
                        `${profit > 0 ? ':dollar:' : ':small_red_triangle_down:'} ` +
                        `Sold token ${memeTokenMeta.symbol} on ${dex} for ${returnAmountAdjusted.toFixed(4)} ${this.baseAssetName}. ` +
                        `PnL: ${profit > 0 ? '+' : ''}${profit.toFixed(4)} ${this.baseAssetName} ($${usdValue.toFixed(2)}) <@352761566401265664>\n${pair.coinhallLink}` +
                        `\ntx: https://explorer.injective.network/transaction/${result.txHash}`
                    );
                    return result;
                }
            } catch (error) {
                console.error(`Error executing swap (Attempt ${retryCount + 1}/${maxRetries}):`, error);
                retryCount += 1;
                spread += 0.2
            }
        }
        console.error(`Exceeded maximum retry attempts (${maxRetries}). Sell operation failed.`);
        this.sendMessageToDiscord(`Failed to sell token ${memeTokenMeta.symbol} ${pair.coinhallLink} ${this.discordTag}`)

        return null
    }

    async formatPortfolioMessage(portfolio) {
        let formattedMessage = '';

        for (const balance of portfolio.bankBalancesList) {
            if (Number(balance.amount) <= 0 || !balance.amount) continue;

            if (balance.denom === this.baseDenom) {
                let usdValue = (this.baseAssetPrice / Math.pow(10, this.stableAsset.decimals)) * (balance.amount / Math.pow(10, this.baseAsset.decimals))
                formattedMessage += `${this.baseAssetName}: ${(balance.amount / Math.pow(10, this.baseAsset.decimals)).toFixed(2)} :dollar: $${usdValue.toFixed(2)}\n`
                continue
            }

            const pair = Array.from(this.allPairs.values()).find(pair => {
                return (
                    pair.token0Meta.denom === balance.denom ||
                    pair.token1Meta.denom === balance.denom
                );
            });

            if (pair) {
                const tokenDenom = pair.asset_infos[0].native_token.denom === balance.denom
                    ? pair.token0Meta
                    : pair.token1Meta;

                const quote = await this.getSellQuoteFromRouter(pair, balance.amount);

                if (quote) {
                    const amountBack = (quote.amount / Math.pow(10, this.baseAsset.decimals)).toFixed(3);
                    const convertedQuote = quote.amount / Math.pow(10, this.baseAsset.decimals)
                    const baseAssetPriceConverted = this.baseAssetPrice / Math.pow(10, this.stableAsset.decimals)

                    const usdValue = (convertedQuote * baseAssetPriceConverted)

                    if (usdValue.toFixed(2) > 0) {
                        formattedMessage += `${(balance.amount / Math.pow(10, tokenDenom.decimals)).toFixed(2)} ` +
                            `${tokenDenom.symbol} (${amountBack} ${this.baseAssetName} :dollar: $${usdValue.toFixed(2)}) ` +
                            `liquidity: $${pair.liquidity.toFixed(2)} ${pair.coinhallLink}\n`;
                    }
                }
            }
        }

        return formattedMessage.trim();
    }

    async monitorPairToSell(pair, intervalInSeconds) {
        try {
            let pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`;

            if (this.sellPairPriceMonitoringIntervals.has(pair.contract_addr)) {
                console.log(`Pair ${pairName} is already being monitored to sell.`);
                return;
            }

            const monitoringIntervalId = setInterval(async () => {
                const updatedPair = await this.getPairInfo(pair.contract_addr);
                if (!updatedPair) return
                this.allPairs.set(pair.contract_addr, updatedPair)

                let position = this.positions.get(pair.contract_addr)

                const quote = await this.getSellQuoteFromRouter(updatedPair, position.balance);

                const tokenDenom = pair.token0Meta.denom === position.token_denom
                    ? pair.token0Meta
                    : pair.token1Meta;

                let result = null;

                let currentTime = moment()
                if (currentTime > moment(position.time_bought).add(this.tradeTimeLimit, 'minute')) {
                    console.log(`trade time limit reached (${this.tradeTimeLimit} minutes)`)
                    this.stopMonitoringPairToSell(pair)
                    result = await this.sellMemeToken(pair, position.balance)
                    return
                }

                if (quote) {
                    const baseAssetPriceConverted = this.baseAssetPrice / Math.pow(10, this.stableAsset.decimals)
                    const convertedQuote = quote.amount / Math.pow(10, this.baseAsset.decimals)
                    const amountBack = (quote.amount / Math.pow(10, this.baseAsset.decimals)).toFixed(3);
                    const usdValue = (convertedQuote * baseAssetPriceConverted)
                    const convertedBalance = position.balance / Math.pow(10, tokenDenom.decimals)
                    const price = usdValue / convertedBalance

                    const moonBagGoal = Math.round((this.snipeAmount * 5) * Math.pow(10, this.baseAsset.decimals))

                    if (position.is_moon_bag && Number(quote.amount) > Number(moonBagGoal)) {
                        console.log(`taking profit on moon bag for ${tokenDenom.symbol}`)
                        this.stopMonitoringPairToSell(pair)
                        result = await this.sellMemeToken(pair, position.balance)
                        return
                    }
                    if (position.is_moon_bag) {
                        console.log(`${pairName} moon bag balance: ${(convertedBalance).toFixed(2)} ${tokenDenom.symbol}, ` +
                            `price: $${price.toFixed(8)} (${amountBack} ${this.baseAssetName} $${usdValue.toFixed(2)})`)
                        return
                    }

                    const percentageIncrease = ((quote.amount - position.amount_in) / position.amount_in) * 100;

                    if (percentageIncrease <= this.stopLoss * -1 && quote.amount < position.amount_in) {
                        console.log(`stop loss hit for ${tokenDenom.symbol} ${percentageIncrease}%`)
                        this.stopMonitoringPairToSell(pair)
                        result = await this.sellMemeToken(pair, position.balance)
                        return
                    }
                    if (percentageIncrease >= this.profitGoalPercent && quote.amount > position.amount_in) {
                        console.log(`profit goal reached for ${tokenDenom.symbol} ${percentageIncrease}%`)
                        this.stopMonitoringPairToSell(pair)
                        if (percentageIncrease >= this.profitGoalPercent * 2) {
                            result = await this.sellMemeToken(pair, Number(position.balance) * 0.6)
                        }
                        else {
                            result = await this.sellMemeToken(pair, Number(position.balance) * (1 - this.moonBagPercent))
                        }
                        return result
                    }

                    console.log(`${pairName}: balance: ${(convertedBalance).toFixed(2)} ${tokenDenom.symbol}, ` +
                        `price: $${price.toFixed(8)} (${amountBack} ${this.baseAssetName} $${usdValue.toFixed(2)}) ${percentageIncrease.toFixed(2)}%`)
                }
            }, intervalInSeconds * 1000);

            this.sellPairPriceMonitoringIntervals.set(pair.contract_addr, monitoringIntervalId);

            console.log(`Sell - Monitoring started for ${pairName}.`);
        } catch (error) {
            console.error('Error monitoring pair:', error);
        }
    }

    stopMonitoringPairToSell(pair) {
        let pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`
        if (this.sellPairPriceMonitoringIntervals.has(pair.contract_addr)) {
            clearInterval(this.sellPairPriceMonitoringIntervals.get(pair.contract_addr));
            this.sellPairPriceMonitoringIntervals.delete(pair.contract_addr);

            console.log(`Monitoring to sell stopped for ${pairName}.`);
        } else {
            console.log(`Pair ${pairName} is not being monitored.`);
        }
    }

    async startMonitoringLowLiquidityPairs() {
        const lowLiquidityPairs = Array.from(this.allPairs.values()).filter(pair => {
            return pair.liquidity < this.lowLiquidityThreshold;
        });

        const lowLiquidityPollInterval = 30; // seconds
        for (const pair of lowLiquidityPairs) {
            await this.monitorLowLiquidityPair(
                pair,
                lowLiquidityPollInterval,
                this.lowLiquidityThreshold
            );
        }
    }

    async monitorPairs(pairsToMonitorPrice) {
        const pairsToMonitor = Array.from(this.allPairs.values()).filter(pair => {
            return (
                (pairsToMonitorPrice.includes(pair.token0Meta.symbol) || pairsToMonitorPrice.includes(pair.token1Meta.symbol)) &&
                pair.liquidity > this.lowLiquidityThreshold
            );
        });

        const trackingPollInterval = 10; // seconds
        const trackingPriceDuration = 5; // minutes
        const priceChangePercentNotificationThreshold = 5; // percent

        for (const pair of pairsToMonitor) {
            await this.monitorPairForPriceChange(
                pair,
                trackingPollInterval,
                trackingPriceDuration,
                priceChangePercentNotificationThreshold
            );
        }
    }

    startStreamingTransactions() {
        const endpoints = getNetworkEndpoints(Network.Mainnet)
        const indexerGrpcExplorerStream = new IndexerGrpcExplorerStream(
            endpoints.indexer,
        )

        const streamFn = indexerGrpcExplorerStream.streamTransactions.bind(
            indexerGrpcExplorerStream,
        )

        const callback = async (transaction) => {
            console.log(transaction)


        }

        const streamFnArgs = {
            callback,
        }

        streamFn(streamFnArgs)
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

    async checkPairForProvideLiquidity(pairContract) {
        let pair;
        pair = this.allPairs.get(pairContract)
        if (!pair) {
            pair = await this.getPairInfo(pairContract)
        }
        const pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`;

        const memeTokenMeta = pair.token0Meta.denom === this.baseDenom
            ? pair.token1Meta
            : pair.token0Meta;

        const startTime = new Date().getTime();
        const contractAddress = pairContract;
        let limit = 100;
        let skip = 0;

        const trippyHoldersLink = `https://trippyinj.xyz/token-holders?address=${memeTokenMeta.denom}`
        const trippyLiquidityLink = `https://trippyinj.xyz/token-liquidity?address=${pairContract}`

        let allTransactions = [];
        let transactions = await this.indexerRestExplorerApi.fetchContractTransactions({
            contractAddress,
            params: {
                limit,
                skip,
            },
        });

        try {
            console.log(`total tx for ${pairName} : ${transactions.paging.total}`);
            do {
                const currentTransactions = transactions.transactions || [];
                allTransactions.push(...currentTransactions);

                if (currentTransactions.length == 0) {
                    break
                }

                let toSkip = (skip + limit) > transactions.paging.total ? transactions.paging.total - skip : limit;
                skip += Number(toSkip);
                skip = Math.min(skip, 10000);

                transactions = await this.indexerRestExplorerApi.fetchContractTransactions({
                    contractAddress,
                    params: {
                        limit,
                        skip,
                    },
                });
            } while (allTransactions.length < transactions.paging.total);
        } catch (error) {
            console.error("An error occurred getting pair transactions:", error);
            // console.log(transactions);
        }

        let baseAssetDecimals = this.baseAsset.decimals

        console.log(`got tx ${allTransactions.length}`)

        await Promise.all(
            allTransactions.map(async (tx) => {
                const txHash = tx.txHash;
                const txInfo = await this.getTxByHash(txHash);
                if (!txInfo) return
                await Promise.all(
                    txInfo.messages.map(async (msg) => {
                        let message;
                        try {
                            message = JSON.parse(msg.message.msg);
                        } catch (error) {
                            message = msg.message.msg;
                        }
                        if (typeof message === 'object' && message.provide_liquidity) {
                            let baseAssetAmount = 0;

                            let memeAddress = ""

                            if (message.provide_liquidity) {
                                const info = message.provide_liquidity.pair_msg?.provide_liquidity || message.provide_liquidity;
                                if (info.assets) {
                                    const assetInfo = (info.assets[0].info?.token?.contract_addr) || info.assets[0].info?.native_token.denom;
                                    memeAddress = assetInfo
                                    baseAssetAmount = assetInfo === this.baseDenom ? info.assets[0].amount : info.assets[1].amount;
                                    console.log(JSON.stringify(info.assets, null, 2))
                                    console.log(pair.asset_decimals)
                                    if (pair.asset_decimals) {
                                        baseAssetDecimals = assetInfo === this.baseDenom ? pair.asset_decimals[0] : pair.asset_decimals[1]
                                    }

                                }
                            }
                            console.log(`https://explorer.injective.network/transaction/${txHash}`)
                            const numericBaseAssetAmount = Number(baseAssetAmount) / 10 ** (baseAssetDecimals || 0);
                            const liquidity = (numericBaseAssetAmount * this.baseAssetPrice * 2) / 10 ** this.stableAsset.decimals;
                            const txTime = moment(txInfo['blockTimestamp'], 'YYYY-MM-DD HH:mm:ss.SSS Z');
                            console.log(`${pairName} liquidity added: $${liquidity} ${txTime.fromNow()}`);


                            if (txTime < moment().subtract(15, 'minute')) {
                                console.log(`liq added over time limit: ${txTime.fromNow()}`)
                                this.stopMonitorPairForLiq(pairContract);
                                return
                            }

                            if (
                                liquidity > 0 && liquidity < this.lowLiquidityThreshold &&
                                txTime > moment().subtract(1, 'minute')
                            ) {
                                this.stopMonitorPairForLiq(pairContract);
                                console.log("small amount of liquidity added")
                                this.sendMessageToDiscord(`:eyes: ${pairName} - Small liquidity Added: $${liquidity}\n` +
                                    `<t:${txTime.unix()}:R>\n` +
                                    `add liq tx: https://explorer.injective.network/transaction/${txHash}\n` +
                                    `view holders: ${trippyHoldersLink}\n` +
                                    `view liquidity holders: ${trippyLiquidityLink}\n` +
                                    `<@352761566401265664>`)

                                // await this.monitorPairForPriceChange(pair, 5, 5, 5)

                                this.sendMessageToTelegram(
                                    `👀 ${pairName} - Liquidity Added from tx: $${liquidity}\n` +
                                    `${txTime.format()}\n` +
                                    `add liq tx: https://explorer.injective.network/transaction/${txHash}\n` +
                                    `view holders: ${trippyHoldersLink}\n` +
                                    `view liquidity holders: ${trippyLiquidityLink}`
                                )
                                return;
                            }

                            if (
                                liquidity > this.lowLiquidityThreshold &&
                                liquidity < this.highLiquidityThreshold &&
                                txTime > moment().subtract(1, 'minute')
                            ) {
                                this.stopMonitorPairForLiq(pairContract);
                                this.sendMessageToDiscord(`:eyes: ${pairName} - Liquidity Added from tx: $${liquidity}\n` +
                                    `<t:${txTime.unix()}:R>\n` +
                                    `add liq tx: https://explorer.injective.network/transaction/${txHash}\n` +
                                    `view holders: ${trippyHoldersLink}\n` +
                                    `view liquidity holders: ${trippyLiquidityLink}\n` +
                                    `<@352761566401265664>`)

                                this.sendMessageToTelegram(
                                    `👀 ${pairName} - Liquidity Added from tx: $${liquidity}\n` +
                                    `${txTime.format()}\n` +
                                    `add liq tx: https://explorer.injective.network/transaction/${txHash}\n` +
                                    `view holders: ${trippyHoldersLink}\n` +
                                    `view liquidity holders: ${trippyLiquidityLink}`
                                )

                                if (this.live) {
                                    await this.buyMemeToken(pair, this.snipeAmount);
                                }
                                else {
                                    // this.monitorPairForPriceChange(pair, 10, 10, 10)
                                }

                                return;
                            }
                        }
                    })
                );
            })
        );

        const endTime = new Date().getTime();
        const executionTime = endTime - startTime;
        // console.log(`Finished check for liq for pair ${pairName} in ${executionTime} milliseconds`.gray);
    }

    async handleNewPair(pair) {
        let pairInfo = await this.getPairInfo(pair.address);
        let dex = ""
        if (pair.factory == this.astroFactory) {
            dex = "Astroport"
        }
        if (pair.factory == this.dojoSwapFactory) {
            dex = "DojoSwap"
        }

        const txTime = moment(pair.tx['blockTimestamp'], 'YYYY-MM-DD HH:mm:ss.SSS Z');

        console.log(JSON.stringify(pairInfo, null, 2))

        const memeTokenMeta = pairInfo.token0Meta.denom === this.baseDenom
            ? pairInfo.token1Meta
            : pairInfo.token0Meta;

        const trippyHoldersLink = `https://trippyinj.xyz/token-holders?address=${memeTokenMeta.denom}`
        const trippyLiquidityLink = `https://trippyinj.xyz/token-liquidity?address=${pair.address}`

        if (
            pairInfo &&
            pairInfo.token0Meta &&
            pairInfo.token1Meta &&
            this.tokenTypes.includes(pairInfo.token0Meta.tokenType) &&
            this.tokenTypes.includes(pairInfo.token1Meta.tokenType) &&
            (pairInfo.token0Meta.denom === this.baseDenom ||
                pairInfo.token1Meta.denom === this.baseDenom)
        ) {
            this.allPairs.set(pair.address, { ...pairInfo, "factory": pair.factory });
            const message = `:new: New pair found on ${dex}: ${pairInfo.token0Meta.symbol}, ` +
                `${pairInfo.token1Meta.symbol}: \n` +
                `<t:${txTime.unix()}:R>\n` +
                `${dex == "DojoSwap" ? pairInfo.dojoSwapLink : pairInfo.astroportLink}\n` +
                `${pairInfo.coinhallLink}\n` +
                `create pair tx: https://explorer.injective.network/transaction/${pair.txHash}\n` +
                `view holders: ${trippyHoldersLink}` +
                `<@352761566401265664>`;

            if (txTime > moment().subtract(10, 'minute')) await this.sendMessageToTelegram(
                `🆕 New pair found on ${dex}: ${pairInfo.token0Meta.symbol}, ` +
                `${pairInfo.token1Meta.symbol}: \n` +
                `${txTime.format()}\n` +
                `create pair tx: https://explorer.injective.network/transaction/${pair.txHash}\n` +
                `view holders: ${trippyHoldersLink}\n` +
                `view liquidity holders: ${trippyLiquidityLink}`
            )

            if (txTime > moment().subtract(10, 'minute')) this.sendMessageToDiscord(message);

            await this.calculateLiquidity(pairInfo);
            console.log(`${pair.address} liquidity: ${pairInfo.liquidity}`)

            if (
                pairInfo.liquidity > this.lowLiquidityThreshold &&
                pairInfo.liquidity < this.highLiquidityThreshold &&
                txTime > moment().subtract(1, 'minute') && this.live
            ) {
                await this.buyMemeToken(pairInfo, this.snipeAmount);
            } else if (txTime > moment().subtract(5, 'minute')) {
                this.startMonitorPairForLiq(pair.address);
            }

        }
        else {
            const message = `:new: New pair found on ${dex}: ${pairInfo.token0Meta.symbol}, ` +
                `${pairInfo.token1Meta.symbol}: \n` +
                `<t:${txTime.unix()}:R>\n` +
                `${dex == "DojoSwap" ? pairInfo.dojoSwapLink : pairInfo.astroportLink}\n` +
                `${pairInfo.coinhallLink}\n` +
                `create pair tx: https://explorer.injective.network/transaction/${pair.txHash}\n` +
                `<@352761566401265664>`;

            console.log(`Ignored pair ${pair.address}, ${JSON.stringify(pairInfo, null, 2)}`);

            if (txTime > moment().subtract(10, 'minute')) this.sendMessageToDiscord(message);

            if (txTime > moment().subtract(10, 'minute')) await this.sendMessageToTelegram(
                `🆕 New pair found on ${dex}: ${pairInfo.token0Meta.symbol}, ` +
                `${pairInfo.token1Meta.symbol}: \n` +
                `${txTime.format()}\n` +
                `create pair tx: https://explorer.injective.network/transaction/${pair.txHash}\n` +
                `view holders: ${trippyHoldersLink}\n` +
                `view liquidity holders: ${trippyLiquidityLink}`
            )

            this.ignoredPairs.add(pair.address);
        }
    }

    startMonitorPairForLiq(pair) {
        this.lowLiqPairsToMonitor.add(pair)
        if (this.lowLiqPairsToMonitor.size == 1) {
            this.liquidityLoop()
        }
    }

    stopMonitorPairForLiq(pair) {
        this.lowLiqPairsToMonitor.delete(pair)
    }

    async liquidityLoop() {
        console.log(`liquidity loop: ${this.lowLiqPairsToMonitor.size > 0}`);

        while (this.lowLiqPairsToMonitor.size > 0) {
            for (const pair of this.lowLiqPairsToMonitor.values()) {
                await this.checkPairForProvideLiquidity(pair);
            }
            await new Promise(resolve => setTimeout(resolve, 2500));
        }
    }

    async setMonitorNewPairs(monitor) {
        this.monitorNewPairs = monitor
        console.log(`new pairs loop: ${this.monitorNewPairs}`.bgCyan)
        if (monitor) {
            this.sendMessageToDiscord(':dart: Begin monitoring for new pairs on Astroport and DojoSwap')
            await this.newPairsLoop()
        }
        else {
            this.sendMessageToDiscord(':pause_button: Stop monitoring for new pairs')
        }
    }

    async newPairsLoop() {
        while (this.monitorNewPairs) {
            try {
                let newAstroPairs = await this.astroport.checkForNewPairs(this.allPairs, this.ignoredPairs);
                for (const pair of newAstroPairs) {
                    await this.handleNewPair(pair)
                }
            }
            catch (e) {
                console.log("error getting new astro pairs", e.originalMessage ? e.originalMessage : e)
            }


            try {
                let newDojoPairs = await this.dojoSwap.checkForNewPairs(this.allPairs, this.ignoredPairs);
                for (const pair of newDojoPairs) {
                    await this.handleNewPair(pair)
                }
            }
            catch (e) {
                console.log("error getting new dojo pairs", e.originalMessage ? e.originalMessage : e)
            }


            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

}

module.exports = InjectiveSniper;