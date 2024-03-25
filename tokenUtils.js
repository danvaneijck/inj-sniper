const InjectiveTokenTools = require("./modules/utils")
const moment = require('moment');
const { getNetworkEndpoints, Network } = require('@injectivelabs/networks');

const endpoints = getNetworkEndpoints(Network.Testnet)
console.log(endpoints)

const CONFIG = {
    endpoints: endpoints,
    // gRpc: "https://sentry.chain.grpc-web.injective.network",
    // explorerAPI: `https://sentry.explorer.grpc-web.injective.network/api/explorer/v1`
    gRpc: "https://testnet.sentry.chain.grpc-web.injective.network",
    explorerAPI: "https://testnet.sentry.explorer.grpc-web.injective.network/api/explorer/v1",
}

const main = async () => {
    try {
        const tools = new InjectiveTokenTools(CONFIG);

        await tools.init()

        // const preSaleWallet = "inj1um7dsq0u2thulf8cxtn63fmugu864ekjtt7gd5"
        const preSaleWallet = "inj1q2m26a7jdzjyfdn545vqsude3zwwtfrdap5jgz"

        await tools.getTxFromAddress(preSaleWallet);

        const start = moment("2024-03-24T05:29:00+13:00")
        const end = moment("2024-03-24T05:35:00+13:00")

        const maxCap = Number(42069) // INJ
        const minPerWallet = Number(0.42) // INJ
        const maxPerWallet = Number(69) // INJ

        const totalRaised = await tools.getPreSaleAmounts(
            preSaleWallet,
            start,
            end,
            maxCap,
            minPerWallet,
            maxPerWallet
        )

        await tools.generateRefundList()
        // await tools.sendRefunds(preSaleWallet)

        const tokenSupply = 1000000000
        const tokenDecimals = 18
        const airdropPercent = 0.5

        await tools.generateAirdropCSV(
            totalRaised,
            tokenSupply,
            tokenDecimals,
            airdropPercent,
            "data/airdrop.csv"
        )

    } catch (error) {
        console.error("An error occurred:", error);
    }
};


const start = async () => {
    await main();
};

start();
