# Coverage inventory: Dallas pilot

Checked October 1, 2026. Every family the PRD lists, whether it works, and why.

| Family | Tier | Status | Source and access | Notes |
|---|---|---|---|---|
| Local reporting | Announcements | Works when `RSS_FEEDS` is set | Operator-supplied RSS/Atom feeds with permission | Keeps headline, link and date only. Items without an address go to geographic review. "Opens" is treated as announced, not open. |
| Company announcements | Announcements | Operator entry | Console form at `/ops?tab=manual` | Operator writes the summary; source link required. |
| Public websites | Announcements | Operator entry | Console form | Same as above. |
| Job postings | Announcements | Unavailable | — | No licensed job-posting source. When added, they stay "Early signal" and can't confirm an opening. |
| Building permits | Balanced | **Unavailable** | — | Dallas Socrata `e7gq-4sah` is historical (last updated Aug 2020). City ArcGIS `NewPermit_2008_2024` ends in 2024. DallasNow (Accela, live since May 2025) has no public API; scraping it would bypass its terms, so it is disabled. Revisit if the city publishes a feed or grants API access. |
| Certificates of occupancy | Balanced | **Unavailable** | — | No current open feed found. |
| Business registrations | Balanced | Unavailable | — | No suitable open API. |
| Alcohol permit applications and licenses | Balanced | **Works** | data.texas.gov SODA API: `mxm5-tdpj` (pending original applications), `7hf9-qc9f` (licenses) | Daily, public. Filtered to `city = DALLAS`. A canceled license is never reported as a business closure. |
| Planning applications | Deep | Unavailable | — | Dallas planning requests reach the public record as zoning cases. |
| Zoning cases and amendments | Deep | **Works** | Legistar Web API (`webapi.legistar.com/v1/cityofdallas/matters`), types starting "ZONING CASES" | Case text is diffed, so amendments become changes. Address is extracted from the case text; cases without one go to geographic review. |
| Ordinances | Deep | Unavailable | Legistar has them | Adapter not built yet. |
| Council and board agendas | Deep | Unavailable | Legistar events | Adapter not built yet. |

## Verify the live sources

From a machine with internet access:

```sh
npm run check:sources
```

It calls each adapter once for the last 30 days and prints the count and an example, without writing anything. The adapters were written against the published column schemas and tested on payloads of that shape, but they have not been run against the live endpoints from this build environment.
