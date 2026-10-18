# Patient food log — Google Apps Script web app

`foodlog.gs` receives meal entries from `foodlog.html` (no patient sign-in) and saves them into the clinic owner's Drive.
It has **no read endpoint** and never returns stored data or patient names.

## Deploy (clinic owner, once — about 5 minutes)

1. On **admin.html**, sign in as the clinic owner and press **Save access** once (this creates `tcm-clinic-foodlog-codes.json` and the 10 `tcm-clinic-foodlog-NN.json` files in "TCM Consult Assistant").
2. Go to <https://script.google.com> with the **same owner Google account** → **New project**. Name it "TCM food log".
3. Delete the sample code, paste the whole of `foodlog.gs`, and press **Save**.
4. Project Settings (⚙) → make sure the **V8 runtime** is enabled.
5. **Deploy → New deployment** → type **Web app**. Description "food log". **Execute as: Me**. **Who has access: Anyone**. Press **Deploy**.
6. Approve the permission prompt (Google Drive access for your own account; "Advanced → Go to TCM food log" if Google warns that the app is unverified — it is your own script).
7. Copy the **Web app URL** (ends with `/exec`).
8. On **admin.html**, paste it into **Patient food log → Food log web app URL** and press **Save access**.
9. Test: in index.html open a patient → **Food log** → **Generate food log link** → open the link on a phone and send an entry → press ↻ in the Food log section.

## Updating the script later
Paste the new code, then **Deploy → Manage deployments → ✏ (edit) → Version: New version → Deploy**. The URL stays the same (do not create a *new* deployment, or the links' web app id changes).

## Limits (edit at the top of the script)
- 40 entries per link per hour, 600 per hour in total.
- Text ≤ 1000 characters, note ≤ 500, photo ≤ ~300 KB (JPEG/PNG/WebP data URL only).
- Entries more than 31 days old or more than 36 hours in the future are refused.
- Unknown or turned-off codes are refused (`invalid_code` / `inactive_code`).
