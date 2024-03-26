const InjectiveTokenTools = require("./modules/utils");
const moment = require("moment");
const { MAIN_NET, TEST_NET } = require("./constants");
const { PrivateKey } = require("@injectivelabs/sdk-ts");

const main = async () => {

    try {
        const tools = new InjectiveTokenTools(MAIN_NET);
        await tools.init();

        const privateKey = PrivateKey.fromMnemonic(process.env.MNEMONIC);
        const publicKey = privateKey.toAddress();
        const preSaleWallet = publicKey.toBech32();

        await tools.getTxFromAddress(preSaleWallet);

        const maxCap = Number(2000); // INJ
        const minPerWallet = Number(0.42); // INJ
        const maxPerWallet = Number(69); // INJ

        // TODO get sent token amounts
        const totalRaised = await tools.getPreSaleAmounts(
            preSaleWallet,
            maxCap,
            minPerWallet,
            maxPerWallet
        );

        // SEND REFUNDS
        await tools.generateRefundList()
        // await tools.sendRefunds(preSaleWallet)

        // PREPARE AIRDROP
        const tokenSupply = 1000000000; //  1 bill = $1
        const tokenDecimals = 18;
        const airdropPercent = 0.5;     // 50 % LP
        const devAllocation = 0.05;     // 0.5 % for from airdrop

        await tools.generateAirdropCSV(
            totalRaised,
            tokenSupply,
            tokenDecimals,
            airdropPercent,
            devAllocation,
            "data/airdrop.csv"
        );
        return

        // CREATING THE TOKEN
        const tokenDenom = await tools.createCW20Token(
            tokenSupply,
            tokenDecimals
        );
        // const tokenDenom = "inj1puwde6qxl5v96f5sw0dmql4r3a0e9wvxp3w805"
        console.log(`new token denom ${tokenDenom}`);

        // SEND THE AIRDROP
        await tools.sendAirdrop(tokenDenom)

        // CREATING THE POOL
        const result = await tools.createDojoPool(tokenDenom);
        const pairAddress = result.pairAddress;
        const liquidityTokenAddress = result.liquidityTokenAddress;

        // const pairAddress = "inj1myuxrdrd060wunzdzqxda3n2guedsn3nzxm9mj"
        // const liquidityTokenAddress = "inj1pn90xurugx5mv4mfeahsuxlh78sf3xx84egfzf"

        let amountToDrop =
            tokenSupply * Math.pow(10, tokenDecimals) * airdropPercent;
        let tokenAmount =
            amountToDrop / Math.pow(10, tokenDecimals) + "0".repeat(18);
        // TODO BEFORE LAUNCH let injAmount = (totalRaised * Math.pow(10, 18)).toString();

        // PROVIDING LIQUIDITY
        await tools.increaseAllowance(pairAddress, tokenDenom, tokenAmount);
        await tools.provideLiquidity(
            pairAddress,
            tokenDenom,
            tokenAmount,
            (0.001 * Math.pow(10, 18)).toString()
        );

        // BURN IT ALL
        await tools.burnLiquidity(liquidityTokenAddress);
    } catch (error) {
        console.error("An error occurred:", error);
    }
};

const start = async () => {
    await main();
};

start();
