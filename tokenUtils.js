const InjectiveTokenTools = require("./modules/utils")


const CONFIG = {
    gRpc: "https://sentry.chain.grpc-web.injective.network",
}

const main = async () => {
    try {
        const tools = new InjectiveTokenTools(CONFIG);

        await tools.getPreSaleParticipants("inj1um7dsq0u2thulf8cxtn63fmugu864ekjtt7gd5");

    } catch (error) {
        console.error("An error occurred:", error);
    }
};

main()