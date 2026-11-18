# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/azazelak/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/azazelak/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Build the best token launch radar. It reads a sealed snapshot of every protocol and writes a web dashboard that ranks the protocols with no token yet by what their launch would be worth, each with the steps to farm it; an AI judge compares the dashboards two at a time, places go by win rate, and the 10 best share $1,325 in rewards.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /input/snapshot.json
```

Node 22 or later, standard library only — nothing to install. The program reads the sealed snapshot, writes `board.json` (178 pre-token protocols ranked by comps-fitted implied launch value, each with a Farm / Thin / Skip verdict and a 6-step farm plan), the dashboard's `data.js`, and `dossier.json` via the vendored `buildDossier`. Open `out/dashboard/index.html` from disk — the page renders with no network.

---

<sub>Entered on [make.fun](https://make.fun/?ref=c652wjep&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
