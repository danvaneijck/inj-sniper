const InjectiveTokenTools = require("./modules/utils");
const { MAIN_NET, TEST_NET } = require("./constants");
const { PrivateKey } = require("@injectivelabs/sdk-ts");

const main = async () => {


    try {
        const tools = new InjectiveTokenTools(MAIN_NET);
        await tools.init();

        const privateKey = PrivateKey.fromMnemonic(process.env.MNEMONIC);
        const publicKey = privateKey.toAddress();
        const address = publicKey.toBech32()


    } catch (error) {
        console.error("An error occurred:", error);
    }
};

const start = async () => {
    await main();
};

start();
