# corpus-agent-wallet-plugin

A [MetaMask Agent Wallet](https://docs.metamask.io/agent-wallet/) plugin that gives an agent four compute
superpowers on Monad, with every signature and transaction routed through the Agent Wallet:

- **`mm corpus price`** buys any price from [corpusAI Cloud Pricing](https://cloud.trycorpus.ai) by paying the
  x402 402 in USDC on Monad. The EIP-3009 authorization is signed by the wallet (`typed-data` request), verified
  against the offer, and resubmitted. Spend is capped by `--max-spend`.
- **`mm corpus oracle`** reads the latest publisher-signed GPU-hour fixing from `FixingOracle` on Monad.
- **`mm corpus sizes` / `mint` / `redeem`** list, buy and redeem permanently funded corpus machines as ERC-1155
  tokens (`ComputeToken`), with approvals and mints as wallet `transaction` requests.
- **`mm corpus book` / `trade`** read and trade the tokens on their [Kuru](https://kuru.io) order book
  (cS1-256/USDC): market orders against resting liquidity, or limit orders that rest on the book, with
  ComputeTokens wrapped into the market's ERC-20 automatically when selling. Buys are capped by `--max-spend`.

Agent instructions live in [`skills/corpus-compute/SKILL.md`](skills/corpus-compute/SKILL.md).

## Install

```bash
npm install -g @metamask/agent-wallet
mm config set experimentalPlugins true
mm plugins install corpus-agent-wallet-plugin --accept-permissions
mm corpus price --ticker CX.H100SXM.NEO --json
```

From source: `npm install && npm run build && mm config set experimentalAllowUnverifiedInstalls true && mm plugins install "file:$PWD" --accept-permissions`.

## Capabilities

| command | capabilities | what it does |
|---|---|---|
| `corpus:price` | wallet-read, wallet-submit | signs an x402 USDC authorization on Monad (typed data) |
| `corpus:oracle` | wallet-read | contract read |
| `corpus:sizes` | wallet-read | contract reads, active account's balances |
| `corpus:mint` | wallet-read, wallet-submit | USDC approve + `mint` transactions |
| `corpus:redeem` | wallet-read, wallet-submit | `redeem` transaction |
| `corpus:book` | wallet-read | Kuru order book reads, best ask vs mint price |
| `corpus:trade` | wallet-read, wallet-submit | wrap, approvals, Kuru margin deposit, market or limit order |

No key material is ever handled by the plugin. There is no bypass of the wallet's signing, policy or MFA.

## Part of corpusAI on Monad

Built for Monad Metropolis with [corpus-monad](https://github.com/JTraversa/corpus-monad) (oracle, token,
treasury) and the live product at https://hackathon.trycorpus.ai. Contract addresses: `deployments.md` there.
MIT.
