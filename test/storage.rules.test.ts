import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteApp, initializeApp, type FirebaseApp } from "firebase/app";
import {
  connectStorageEmulator,
  deleteObject,
  getMetadata,
  getStorage,
  listAll,
  ref,
  uploadBytes,
  type FirebaseStorage,
} from "firebase/storage";

const rules = readFileSync(new URL("../storage.rules", import.meta.url), "utf8");

it("keeps exactly the public community read grant and denies every client write", () => {
  // Exact policy contract, not a substitute for the emulator behavior tests below.
  const normalize = (source: string) => source.replace(/\/\/[^\r\n]*/g, "").replace(/\s+/g, "");
  expect(normalize(rules)).toBe(normalize(`
    rules_version = '2';
    service firebase.storage {
      match /b/{bucket}/o {
        match /community/{subAccountId}/{groupId}/{fileName} {
          allow read: if true;
          allow write: if false;
        }
        match /{allPaths=**} {
          allow read, write: if false;
        }
      }
    }
  `));
});

// Run with a dedicated local Storage emulator; no Firebase login or live project.
// firebase emulators:exec --only storage --project demo-maros-storage-rules \
//   "pnpm exec vitest run test/storage.rules.test.ts"
const emulatorHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
describe.skipIf(!emulatorHost)("Storage authorization (local emulator required)", () => {
  const apps: FirebaseApp[] = [];
  const clients: Record<string, FirebaseStorage> = {};
  const bucket = "demo-maros-storage-rules.appspot.com";
  const prefix = `community/tenant-b/${randomUUID()}`;
  const existingImage = `${prefix}/cover.png`;
  const privateImage = `private/${randomUUID()}/cover.png`;
  const nestedImage = `${prefix}/nested/cover.png`;
  const image = new Uint8Array([137, 80, 78, 71]);
  let fixtures: FirebaseStorage;

  beforeAll(async () => {
    if (!emulatorHost || !/^(127\.0\.0\.1|localhost):\d+$/.test(emulatorHost)) {
      throw new Error("Storage rules tests require a loopback FIREBASE_STORAGE_EMULATOR_HOST.");
    }
    const [host, port] = emulatorHost.split(":");
    const response = await fetch(`http://${emulatorHost}/internal/setRules`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rules: { files: [{ name: "storage.rules", content: rules }] } }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Failed to load Storage rules: ${await response.text()}`);

    function client(name: string, mockUserToken?: string | { sub: string; subAccountId: string }) {
      const app = initializeApp({ projectId: "demo-maros-storage-rules", storageBucket: bucket }, `storage-rules-${name}-${randomUUID()}`);
      apps.push(app);
      const storage = getStorage(app);
      connectStorageEmulator(storage, host, Number(port), { mockUserToken });
      storage.maxOperationRetryTime = 1000;
      storage.maxUploadRetryTime = 1000;
      return storage;
    }

    // Emulator-only fixture privilege, matching Firebase's rules test helper.
    // Never used for an authorization assertion or against a non-loopback host.
    fixtures = client("fixtures", "owner");
    clients.anonymous = client("anonymous");
    clients.otherTenant = client("other", { sub: "user-a", subAccountId: "tenant-a" });
    clients.sameTenant = client("same", { sub: "user-b", subAccountId: "tenant-b" });
    for (const path of [existingImage, privateImage, nestedImage]) {
      await uploadBytes(ref(fixtures, path), image, { contentType: "image/png" });
    }
  }, 15000);

  afterAll(async () => {
    try {
      if (fixtures) {
        await Promise.all([existingImage, privateImage, nestedImage].map((path) =>
          deleteObject(ref(fixtures, path)).catch((error: unknown) => {
            if (!(error instanceof Error) || !("code" in error) || error.code !== "storage/object-not-found") throw error;
          }),
        ));
      }
    } finally {
      await Promise.all(apps.map((app) => deleteApp(app)));
    }
  });

  describe.each(["anonymous", "otherTenant", "sameTenant"])("%s client", (identity) => {
    it("cannot create a community image, even when the old image constraints are met", async () => {
      await expect(uploadBytes(ref(clients[identity], `${prefix}/new-${identity}.png`), image, { contentType: "image/png" }))
        .rejects.toMatchObject({ code: "storage/unauthorized" });
    });

    it("cannot overwrite an existing community image", async () => {
      await expect(uploadBytes(ref(clients[identity], existingImage), image, { contentType: "image/png" }))
        .rejects.toMatchObject({ code: "storage/unauthorized" });
    });

    it("cannot delete an existing community image", async () => {
      await expect(deleteObject(ref(clients[identity], existingImage)))
        .rejects.toMatchObject({ code: "storage/unauthorized" });
    });

    it("can still read and list public community images", async () => {
      expect((await getMetadata(ref(clients[identity], existingImage))).fullPath).toBe(existingImage);
      expect((await listAll(ref(clients[identity], prefix))).items.map((item) => item.fullPath)).toContain(existingImage);
    });

    it("cannot read outside the existing public path, including deeper nested objects", async () => {
      for (const path of [privateImage, nestedImage]) {
        await expect(getMetadata(ref(clients[identity], path))).rejects.toMatchObject({ code: "storage/unauthorized" });
      }
    });
  });
});
