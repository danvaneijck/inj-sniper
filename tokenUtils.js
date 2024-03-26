const InjectiveTokenTools = require("./modules/utils")
const moment = require('moment');
const { MAIN_NET, TEST_NET } = require("./constants");

const main = async () => {
    try {

        const tools = new InjectiveTokenTools(MAIN_NET);
        await tools.init()

        // const preSaleWallet = "inj1um7dsq0u2thulf8cxtn63fmugu864ekjtt7gd5" // PING presale

        const preSaleWallet = "inj1q2m26a7jdzjyfdn545vqsude3zwwtfrdap5jgz"
        await tools.getTxFromAddress(preSaleWallet);

        const start = moment("2024-03-24T05:29:00+13:00")
        const end = moment("2024-03-24T05:35:00+13:00")
        const maxCap = Number(42069) // INJ
        const minPerWallet = Number(0.1) // INJ
        const maxPerWallet = Number(10) // INJ

        const totalRaised = await tools.getPreSaleAmounts(
            preSaleWallet,
            start,
            end,
            maxCap,
            minPerWallet,
            maxPerWallet
        )


        // SEND REFUNDS
        // await tools.generateRefundList()
        // await tools.sendRefunds(preSaleWallet)


        // CREATING THE TOKEN
        const tokenSupply = 1000000000
        const tokenDecimals = 18
        const airdropPercent = 0.5
        const devAllocation = 0.01
        const tokenDenom = await tools.createCW20Token(tokenSupply, tokenDecimals)
        console.log(`new token denom ${tokenDenom}`)

        // SEND THE AIRDROP
        await tools.generateAirdropCSV(
            totalRaised,
            tokenSupply,
            tokenDecimals,
            airdropPercent,
            devAllocation,
            "data/airdrop.csv"
        )
        // await tools.sendAirdrop(preSaleWallet, tokenDenom)

        return


        // CREATING THE POOL
        const result = await tools.createDojoPool(tokenDenom)
        const pairAddress = result.pairAddress
        const liquidityTokenAddress = result.liquidityTokenAddress

        let amountToDrop = (tokenSupply * Math.pow(10, tokenDecimals)) * airdropPercent
        let tokenAmount = amountToDrop / Math.pow(10, tokenDecimals) + "0".repeat(18)
        let injAmount = (totalRaised * Math.pow(10, 18)).toString()


        // PROVIDING LIQUIDITY
        await tools.increaseAllowance(pairAddress, tokenDenom, tokenAmount)
        await tools.provideLiquidity(
            pairAddress,
            tokenDenom,
            tokenAmount,
            (0.0001 * Math.pow(10, 18)).toString()
        )


        // BURN IT ALL
        await tools.burnLiquidity(liquidityTokenAddress)

    } catch (error) {
        console.error("An error occurred:", error);
    }
};


const start = async () => {
    await main();
};

start();
