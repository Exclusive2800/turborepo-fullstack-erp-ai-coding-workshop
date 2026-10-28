# NFR-05 load test report

Run: 2026-10-28T10:37:44.431Z → 2026-10-28T10:42:44.609Z
Scale: 1000 products, 10000 movements
Concurrency: 10 simulated concurrent users
Duration: 300s continuous
Threshold: p95 ≤ 2000 ms per endpoint (CSV export excluded)

| Endpoint   | Requests | p50 (ms) | p95 (ms) | max (ms) | Result |
| ---------- | -------: | -------: | -------: | -------: | ------ |
| search     |    12611 |     79.6 |    182.9 |   3030.4 | PASS   |
| stock-view |    12611 |    130.1 |    272.5 |   3795.4 | PASS   |

Overall: PASS
