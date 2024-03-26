const MAIN_NET = {
    grpc: "https://sentry.chain.grpc-web.injective.network",
    explorer: `https://sentry.explorer.grpc-web.injective.network/api/explorer/v1`,
    rest: "https://sentry.lcd.injective.network",
    indexer: "https://sentry.exchange.grpc-web.injective.network",
    chainId: "injective-1",
    dojoFactory: "inj1pc2vxcmnyzawnwkf03n2ggvt997avtuwagqngk",
    explorerUrl: "https://explorer.injective.network"
}

const TEST_NET = {
    grpc: "https://testnet.sentry.chain.grpc-web.injective.network",
    explorer: `https://testnet.sentry.explorer.grpc-web.injective.network/api/explorer/v1`,
    rest: "https://testnet.sentry.lcd.injective.network",
    indexer: "https://testnet.sentry.exchange.grpc-web.injective.network",
    chainId: "injective-888",
    dojoFactory: "inj14mxpetzg9sur0g6m39zu9m9n2ajxvlx4ytlgq3",
    explorerUrl: "https://testnet.explorer.injective.network"
}

module.exports = {
    MAIN_NET, TEST_NET
}