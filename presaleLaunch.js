const InjectiveTokenTools = require("./modules/utils");
const { MAIN_NET, TEST_NET } = require("./constants");
const { PrivateKey } = require("@injectivelabs/sdk-ts");

const main = async () => {


    try {
        const tools = new InjectiveTokenTools(MAIN_NET);
        await tools.init();

        const privateKey = PrivateKey.fromMnemonic(process.env.SNIPER_MNEMONIC);
        const publicKey = privateKey.toAddress();

        // const preSaleWallet = publicKey.toBech32();

        // const shroomAddress = "inj1300xcg9naqy00fujsr9r8alwk7dh65uqu87xm8"

        // await tools.getAccountTx(preSaleWallet);

        // const maxCap = Number(2800);       // INJ
        // const minPerWallet = Number(0.1);  // INJ
        // const maxPerWallet = Number(50);   // INJ

        // const totalRaised = await tools.getPreSaleAmounts(
        //     preSaleWallet,
        //     maxCap,
        //     minPerWallet,
        //     maxPerWallet,
        //     null
        // );

        // // GENERATE AND SEND REFUNDS
        // await tools.generateRefundList()
        // // await tools.sendRefunds(preSaleWallet)

        // const totalAdjustedContribution = await tools.getMultiplier(preSaleWallet, shroomAddress)
        // console.log(`total adjusted contribution ${totalAdjustedContribution}`)

        // // PREPARE AIRDROP
        // const tokenSupply = 1000000000;
        // const tokenDecimals = 18;
        // const lpPercent = 0.5
        // const preSaleAirdropPercent = 1 - lpPercent;
        // const devAllocation = 0.005;

        // await tools.generateAirdropCSV(
        //     totalRaised,
        //     totalAdjustedContribution,
        //     tokenSupply,
        //     tokenDecimals,
        //     preSaleAirdropPercent,
        //     devAllocation,
        //     "data/airdrop.csv"
        // );

        // CREATING THE TOKEN
        // const tokenDenom = await tools.createCW20Token(
        //     tokenSupply,
        //     tokenDecimals
        // );
        // console.log(`new token denom ${tokenDenom}`.bgGreen);

        // SEND THE AIRDROP
        // await tools.sendAirdrop(tokenDenom)


        // CREATING THE POOL
        const result = await tools.createDojoPool("factory/inj1sy2aad37tku3dz0353epczxd95hvuhzl0lhfqh/FUN");
        const pairAddress = result.pairAddress;
        const liquidityTokenAddress = result.liquidityTokenAddress;

        console.log(`pair address ${pairAddress}`.bgGreen)
        console.log(`liquidity token address ${liquidityTokenAddress}`.bgGreen)

        // const pairAddress = "inj1m35kyjuegq7ruwgx787xm53e5wfwu6n5uadurl"
        // const liquidityTokenAddress = "inj1e8ng0tn23yqdlp6mvv4zc9q3phkg40mlsxrwzx"

        // let amountToDrop =
        //     tokenSupply * Math.pow(10, tokenDecimals) * lpPercent;
        // let tokenAmount =
        //     amountToDrop / Math.pow(10, tokenDecimals) + "0".repeat(18);
        // // let injAmount = (totalRaised * Math.pow(10, 18)).toString();


        // // PROVIDING LIQUIDITY
        // await tools.increaseAllowance(pairAddress, tokenDenom, tokenAmount);
        // await tools.provideLiquidity(
        //     pairAddress,
        //     tokenDenom,
        //     tokenAmount,
        //     (24.35 * Math.pow(10, 18)).toString()
        // );

        // // BURN IT ALL
        // await tools.burnLiquidity(liquidityTokenAddress);

    } catch (error) {
        console.error("An error occurred:", error);
    }
};

const start = async () => {
    await main();
};

start();
