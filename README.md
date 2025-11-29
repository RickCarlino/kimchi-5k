# Kimchi 5000

Toolkit for experimenting with the [Kimchi Reader](https://kimchi-reader.app/) word frequency list using OpenAI and Google Cloud Natural Language (lemmatization).

## Setup

- Copy `.env.example` to `.env` and fill in your keys (OpenAI + Google Cloud service account with the Natural Language API enabled).
- Install dependencies (already in `package.json`): `bun install`

## Running

- Summaries via OpenAI: `bun run index.ts summary "Kimchi Reader contains high-frequency Korean vocabulary..."`
- Lemmatization via Google NLP: `bun run index.ts lemmas "Kimchi Reader contains high-frequency Korean vocabulary..."`

The CLI prints a usage hint when run without arguments.
