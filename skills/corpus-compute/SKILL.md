---
name: corpus-compute
description: How an AI agent buys cloud and GPU prices from corpusAI Cloud Pricing over x402 in USDC on Monad, reads the on-chain compute price oracle, and mints or redeems permanently funded compute tokens, all through the MetaMask Agent Wallet plugin @corpusai/agent-wallet-plugin. Use when an agent needs a current or historical cloud, GPU or LLM token price, a verifiable GPU-hour fixing from a contract, or wants to own, transfer or redeem corpus compute.
---

# corpusAI on Monad (`mm corpus …`)

You act through the MetaMask Agent Wallet CLI (`mm`). You never hold keys: every x402 payment authorization
(EIP-712) and every transaction is built by the plugin and signed, policy-checked and possibly held for human
approval by MetaMask. Everything settles in USDC on Monad mainnet (chain 143).

## Setup (once)

```bash
npm install -g @metamask/agent-wallet
mm config set experimentalPlugins true
mm plugins install @corpusai/agent-wallet-plugin --accept-permissions
mm login && mm init
```
The wallet needs a little MON for gas and USDC on Monad: a price costs 0.01 to 0.10 USDC; a compute token costs
its position price (hundreds to thousands of USDC, see `mm corpus sizes`).

## Rules for agents

1. **Prices are cheap, compute is not.** `corpus price` spends at most `--max-spend` (default 0.05 USDC) and
   refuses above it. `corpus mint` moves real money: state size, quantity and the USDC total, and wait for an
   explicit yes before running it.
2. **Use `--json`** and parse `data`. Errors carry a code (`MAX_SPEND_EXCEEDED`, `NO_MONAD_OFFER`,
   `INSUFFICIENT_USDC`, `INSUFFICIENT_TOKENS`, `INACTIVE`, `SIGNING_FAILED`, `TRANSACTION_FAILED`).
3. **Writes can pause for approval.** On `AWAITING_MFA`, stop and ask the user to approve in MetaMask. Never
   resubmit; follow with `mm wallet requests watch <id>`.
4. **Never retry a timed-out mint or redeem** without checking `mm wallet requests list` or the explorer first.
5. **Quote the source.** When you report a price, say it came from corpusAI Cloud Pricing, with the ticker,
   the day and the methodology version in the response.

## Commands

### Buy a price (x402, paid through the Agent Wallet)
```bash
mm corpus price --ticker CX.H100SXM.NEO --json                       # today's H100 SXM fixing, USD per GPU-hour
mm corpus price "/v1/index/tickers" --json                            # free: every ticker the index publishes
mm corpus price "/v1/spot/latest?instance=p5.48xlarge&region=us-east-1" --json
mm corpus price "/v1/gpu/quotes?gpu=H100SXM" --max-spend 0.02 --json
```
Any path under https://cloud.trycorpus.ai works (docs at /docs). The plugin reads the 402, picks the USDC offer on
Monad, has the wallet sign the EIP-3009 authorization, verifies it matches the offer, and resubmits. Response
fields: `paid`, `amountUsdc`, `payer`, `data` (the price JSON; fixings carry `attestation` with the publisher's
EIP-712 signature you can verify offline).

### Read the oracle (free)
```bash
mm corpus oracle CX.H100SXM.NEO --json          # latest fixing stored in FixingOracle on Monad
```
Returns `valueUsd`, `day`, `n` (quote count; below 3 is indicative), `methodology`, `publisher`.

### Own compute
```bash
mm corpus sizes --json                          # sizes, monthly bill, principal, price once, outstanding, held
mm corpus mint 2 1 --json                       # one shared-cpu-1x 1 GB, permanently funded: approve + mint
mm corpus redeem 2 me@example.com --json        # burn it; corpus opens the position for that account
```
One token is one machine whose principal is never spent and whose yield pays the bill. Tokens are ERC-1155 and
transferable with `mm wallet transfer`-class commands or any wallet.

## Addresses
Contracts live in https://github.com/JTraversa/corpus-monad/blob/main/deployments.md. Override with
`--token` / `--oracle` or `CORPUS_TOKEN` / `CORPUS_ORACLE`. Feed: https://cloud.trycorpus.ai. Product page:
https://hackathon.trycorpus.ai.
