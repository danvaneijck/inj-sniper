const InjectiveTokenTools = require("./modules/utils");
const { MAIN_NET, TEST_NET } = require("./constants");
const { PrivateKey } = require("@injectivelabs/sdk-ts");

const main = async () => {


    try {
        const tools = new InjectiveTokenTools(MAIN_NET);
        await tools.init();

        const cheebee = "inj1047jye6gwds2xu7f9qzuwqfjduvjnqt3daf5cy"

        await tools.getNFTCollectionInfo(cheebee)


    } catch (error) {
        console.error("An error occurred:", error);
    }
};

const start = async () => {
    await main();
};

start();
