const InjectiveTokenTools = require("./modules/utils")
const moment = require('moment');


const CONFIG = {
    gRpc: "https://sentry.chain.grpc-web.injective.network",
}

const main = async () => {
    try {
        const tools = new InjectiveTokenTools(CONFIG);

        await tools.init()

        const preSaleAddress = "inj1um7dsq0u2thulf8cxtn63fmugu864ekjtt7gd5"

        // await tools.getTxFromAddress(preSaleAddress);

        let preSaleStart = moment("2024-03-24T05:29:00+13:00")
        let preSaleEnd = moment("2024-03-24T05:35:00+13:00")
        let maxCap = Number(2800) // INJ
        let minPerWallet = Number(0.2) // INJ
        let maxPerWallet = Number(100) // INJ

        tools.getPreSaleAmounts(
            preSaleAddress,
            preSaleStart,
            preSaleEnd,
            maxCap,
            minPerWallet,
            maxPerWallet
        )

        // tools.sendRefunds()
        // tools.generateAirdropCSV


    } catch (error) {
        console.error("An error occurred:", error);
    }
};

main()