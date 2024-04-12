const InjectiveTokenTools = require("./modules/utils");
const { MAIN_NET, TEST_NET } = require("./constants");
const { PrivateKey } = require("@injectivelabs/sdk-ts");

const main = async () => {

    const tokenDenom = "inj1300xcg9naqy00fujsr9r8alwk7dh65uqu87xm8"
    const pairAddress = ""
    const liquidityTokenAddress = ""

    try {
        const tools = new InjectiveTokenTools(MAIN_NET);
        await tools.init();

        const privateKey = PrivateKey.fromMnemonic(process.env.MNEMONIC);
        const publicKey = privateKey.toAddress();
        const address = publicKey.toBech32()

        tools.updateMarketing(tokenDenom)

        // get token holders and amounts
        // await tools.getTokenHolders(tokenDenom)

        // await tools.getTxFromAddress(address);

        // const totalRaised = await tools.getPreSaleAmounts(
        //     address,
        //     10,
        //     0.1,
        //     0.1,
        //     null
        // );

        // GENERATE AND SEND REFUNDS
        // await tools.generateRefundList()
        // await tools.sendRefunds(address)

        // await tools.sendAirdrop(tokenDenom)


    } catch (error) {
        console.error("An error occurred:", error);
    }
};

const start = async () => {
    await main();
};

start();
