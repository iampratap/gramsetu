import "dotenv/config";
import { createApp } from "./app.js";
import { ensureBucket, storageInfo } from "./lib/s3.js";
import { attachRealtime } from "./realtime/hub.js";

const port = Number(process.env.PORT || 4000);
const app = createApp();

await ensureBucket();
const server = app.listen(port, () => {
  const storage = storageInfo();
  console.log(`GramSetu API listening on http://localhost:${port}`);
  console.log(
    `Audio storage: ${storage.driver} bucket=${storage.bucket}` +
      (storage.endpoint ? ` endpoint=${storage.endpoint}` : ""),
  );
});
attachRealtime(server);
