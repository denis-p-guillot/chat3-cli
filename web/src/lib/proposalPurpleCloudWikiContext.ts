/**
 * Curated Purple-Cloud Wiki excerpts + URLs for proposal prompts.
 * Sources: wiki.purple-cloud.ai (Security, Monitoring, PostgreSQL, Backup, Web SSH).
 */

export const PURPLECLOUD_WIKI_SERVICES_FOR_PROPOSAL_PROMPT = `
## PurpleCloud integrated services (Wiki reference — use in the proposal)

Ground operational and security claims in the **official Wiki**. Cite links (Markdown) in a **“Platform & console”** or **“Operations & security”** subsection; paraphrase professionally in the **Output language** requested below.

### [Security](https://wiki.purple-cloud.ai/en/home/Security)
- **Edge & network:** Cloudflare is active by default (WAF, CDN, SSL); customers can adjust/bypass proxy in the instance domain tab when needed.
- **VALUE tier:** DigitalOcean-backed; data centers with recognized certifications, MANRS networking, 24/7 monitoring, documented network/server/storage/virtualization controls (TLS, segmentation, least privilege, encrypted storage at rest, MFA/SSO/SSH options).
- **PERFORMANCE tier:** AWS-backed (EC2, ELB/CloudFront, RDS PostgreSQL, EFS/S3); NVMe instance-store encryption (per-customer keys, hardware module); S3/RDS encryption at rest and in transit; defense-in-depth appropriate to enterprise Odoo.
- **Backups storage (VALUE):** backup objects in Cloudflare R2 — AES-256 at rest, TLS in transit.
- **Application layer:** Summarize Odoo’s authentication stack (reverse proxy, SSL, Fail2ban-aware paths), access control / record rules / field security at a **high level** for prospects; mention OWASP-oriented design (ORM vs SQL injection, XSS escaping, CSRF tokens on website flows, HTTPS-by-default) without dumping low-level tables.

### [Monitoring](https://wiki.purple-cloud.ai/en/console-management/Monitoring)
- From **My Services**, open an instance → **Monitoring** tab: **Odoo workers** (CPU % of available CPU + memory per worker), **PostgreSQL** (CPU % + memory), **Disk usage** (filestore as %).
- Graphs support **1h / 6h / 1d / 30d**, data **every minute**, zoom and range selection—position this as **observability** for capacity planning and incident response.

### [PostgreSQL — running queries](https://wiki.purple-cloud.ai/en/console-management/PostgreSQL-running-queries)
- **CHECK RUNNING QUERY** lists live PostgreSQL statements (paginated); customers can **filter** (e.g. keyword) to isolate slow or hot queries—useful for **performance tuning** and root-cause narratives in proposals.

### [Backup & restore](https://wiki.purple-cloud.ai/en/console-management/backup-and-restore)
- **Automated backups:** all **PERFORMANCE** instances; **VALUE** instances **with a backup option**.
- **Schedule:** default **00:00** in the instance’s deployment timezone (off business hours).
- **Retention:** last **3 months** (3 monthly), **4 weeks** (4 weekly), **7 days** (7 daily); one full backup set per Odoo database on the instance.
- **Prerequisite:** **≥ 35% free filestore** required for automated backups to succeed—call this out under assumptions if filestore is tight.
- **Downloads:** database and filestore are **split**; **GENERATE DOWNLOAD URL** → URLs valid **~1 hour**; match DB backup with its filestore for restores.
- **Restore:** destructive to existing data for that DB—position as “point-in-time recovery”; note that **Restore** is not always the right fix for bad code (rebuild path may apply).

### [Web SSH access](https://wiki.purple-cloud.ai/en/console-management/web-ssh-access)
- Invite **technical users** by email (Users tab) → **GRANT SSH ACCESS** → **GENERATE WEBSSH URL** for a **browser-based secured** shell—useful for **DevOps / integrator** collaboration storylines.

**Proposal usage:** dedicate a short, non-technical executive bullet to “**PurpleCloud console**” (monitoring, backups, DB insight, secure remote access), then **Operations** / **Security** sections that **mirror** this list with **clickable Wiki links** for due diligence readers.
`.trim()
