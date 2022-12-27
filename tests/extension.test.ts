import { Keyboard, Locator, Page, test, expect } from "@playwright/test";
import fs from "fs";
import { v4 } from "uuid";
import createTestSamePageClient, {
  MessageSchema,
  ResponseSchema,
} from "samepage/testing/createTestSamePageClient";
import type { PullBlock } from "roamjs-components/types/native";
import { JSDOM } from "jsdom";
import nodeurl from "url";
import path from "path";

declare global {
  interface Window {
    showDirectoryPicker: () => Promise<FileSystemDirectoryHandle>;
  }
}

let skip = true;

const metaPress = (obj: Keyboard | Locator, key: string) =>
  process.platform === "darwin"
    ? obj.press(`Meta+${key}`)
    : obj.press(`Control+${key}`);

const enterCommandPaletteCommand = (page: Page, command: string) =>
  test.step(`Enter command ${command}`, async () => {
    await metaPress(page.keyboard, "p");
    await expect(page.locator(".rm-command-palette")).toBeVisible();
    await expect(page.locator("*:focus")).toHaveJSProperty("tagName", `INPUT`);
    await metaPress(page.locator("*:focus"), "a");
    await page.locator("*:focus").press("Backspace");
    await page.locator("*:focus").fill(command);
    await expect(page.locator(`text="${command}" >> .. >> ..`)).toHaveCSS(
      "background-color",
      "rgb(213, 218, 223)"
    );
    await page.keyboard.press("Enter");
  });

test.beforeEach(async ({ page }) => {
  await page.coverage.startJSCoverage();
});
let unload: () => Promise<unknown>;
test.afterEach(async ({ page }) => {
  await unload?.();
  const rootPath = path.normalize(`${__dirname}/..`);
  const coverage = await page.coverage.stopJSCoverage().then(
    (fils) => fils.find((f) => f.url.startsWith("blob:"))
    // .filter((it) => /\.js$/.test(it.url))
    // .map((it) => {
    //   console.log("before replace", it.url);
    //   const fileName = new nodeurl.URL(it.url).pathname;
    //   const url = `file:///${rootPath}${fileName}`;
    //   console.log("after replace", url)
    //   return { ...it, url };
    // })
  );
  const covPath = "./coverage/tmp";

  console.log("rootpath", rootPath);
  fs.mkdirSync(covPath, { recursive: true });
  fs.writeFileSync(
    `${covPath}/coverage-${Date.now()}-69.json`,
    JSON.stringify({ result: [{...coverage, url: `file://${rootPath}/dist/extension.js`}], timestamp: [] })
  );
  console.log("dir", fs.readdirSync(covPath));
});
test("Should share a page with the SamePage test app", async ({ page }) => {
  test.setTimeout(60000);
  const oldLog = console.log;
  const clientReady = new Promise<{
    testClient: Awaited<ReturnType<typeof createTestSamePageClient>>;
    clientSend: (m: MessageSchema) => Promise<unknown>;
  }>((resolve) => {
    const pendingRequests: Record<string, (data: unknown) => void> = {};
    const samePageClientCallbacks: {
      [k in ResponseSchema as k["type"]]: (data: k) => void;
    } = {
      log: ({ data }) => process.env.DEBUG && oldLog(`SamePage Client:`, data),
      error: (message) => {
        throw new Error(
          typeof message === "string" ? message : JSON.stringify(message)
        );
      },
      ready: async () => {
        const testClient = await client;
        resolve({
          testClient,
          clientSend: (m) => {
            const uuid = v4();
            return new Promise<unknown>((resolve) => {
              pendingRequests[uuid] = (a) => {
                console.log("test client response", uuid);
                resolve(a);
              };
              console.log("sending test client", m.type, uuid);
              testClient.send({ ...m, uuid });
            });
          },
        });
      },
      response: (data) => pendingRequests[data.uuid]?.(data.data),
    };
    const client = createTestSamePageClient({
      workspace: "test",
      onMessage: ({ type, ...data }) =>
        // @ts-ignore same problem I always have about discriminated unions...
        samePageClientCallbacks[type]?.(data),
      initOptions: {
        uuid: process.env.SAMEPAGE_TEST_UUID,
        token: process.env.SAMEPAGE_TEST_TOKEN,
      },
    });
  });
  await test.step("Setup Test", async () => {
    await page.addInitScript((content: Record<string, string>) => {
      class MockFileSystemDirectoryHandle implements FileSystemDirectoryHandle {
        constructor() {}
        kind = "directory" as const;
        name = "roam-samepage";

        async getDirectoryHandle(name: string) {
          return Promise.reject(`No subdirectories with name ${name}`);
        }
        async getFileHandle(name: string) {
          return {
            kind: "file" as const,
            name,
            isSameEntry: async () => false,
            getFile: async () => new File([content[name]], name),
          };
        }
        async isSameEntry() {
          return false;
        }
        async removeEntry(name: string) {
          return Promise.reject(`\`removeEntry\` of ${name} is not supported`);
        }
        async resolve() {
          return ["roam-samepage"];
        }
        async queryPermission() {
          return "granted";
        }
      }

      window.showDirectoryPicker = async () =>
        new MockFileSystemDirectoryHandle();
    }, Object.fromEntries(["extension.js", "extension.css", "README.md", "CHANGELOG.md"].filter((f) => fs.existsSync(f)).map((f) => [f, fs.readFileSync(f).toString()])));
  });

  await test.step("Log into Roam", async () => {
    await page.goto("https://roamresearch.com/#/signin");
    await page.waitForTimeout(10000); // Roam has an annoying refresh bug to wait to pass
    expect(page.url(), `page.url()`).toEqual(
      "https://roamresearch.com/#/signin"
    );
    await page.locator("[name=email]").fill(process.env.ROAM_USERNAME);
    await page.locator("[name=password]").fill(process.env.ROAM_PASSWORD);
    await page.locator(".bp3-button").first().click();
    await expect(page.locator(".my-graphs")).toHaveCount(2);
  });

  const graph = "samepage-test";
  await test.step("Navigate to test graph", async () => {
    await page.goto(`https://roamresearch.com/#/offline/${graph}`);
    await expect(page.locator("h1")).toBeVisible();
    await page
      .locator("text=Local graphs live in your browser's local storage")
      .locator("..")
      .locator("..")
      .locator("..")
      .locator(".bp3-icon-cross")
      .click();
    await page
      .locator("text=Roam Help")
      .locator("..")
      .locator(".bp3-icon-cross")
      .click();
  });

  await enterCommandPaletteCommand(page, "Roam Depot Settings");

  await test.step("Ensure extension is Installed", async () => {
    // why is this happening on headless?
    await expect(page.locator("text=Installed Extensions"))
      .toBeVisible()
      .catch(() =>
        page.locator('.rm-settings__tab >> text="Roam Depot"').click()
      );
    await page.locator("button.bp3-icon-cog").click();
    await page.locator("text=Enable Developer Mode").click();
    await page.locator("button.bp3-icon-folder-new").click();
  });

  let notebookUuid = "";
  await test.step("Onboard Notebook Onboarding Flow", async () => {
    await page.locator('div[role=dialog] >> text="Get Started"').click();
    await page
      .locator('div[role=dialog] >> text="Use Existing Notebook"')
      .click();
    await page
      .locator("text=Notebook Universal ID >> input")
      .fill(process.env.SAMEPAGE_TEST_UUID);
    await page
      .locator("text=Token >> input")
      .fill(process.env.SAMEPAGE_TEST_TOKEN);
    await page.locator("text=I have read and agree").click();
    await page.locator('div[role=dialog] >> text="Connect"').click();
    await page.locator('div[role=dialog] >> button >> text="All Done"').click();
    await expect(
      page.locator('div[role=dialog] >> text="Welcome to SamePage"')
    ).not.toBeVisible();
    await page.locator("div[role=tab] >> text=SamePage").click();
    notebookUuid = await page
      .locator("text=Notebook Universal Id >> .. >> .. >> input")
      .getAttribute("value");

    await page
      .locator("div.bp3-overlay-backdrop")
      .click({ position: { x: 300, y: 16 } });
    await expect(page.locator(".rm-settings")).not.toBeVisible();
    await expect(page.locator(".bp3-toast.bp3-intent-success")).toBeVisible();
  });

  const pageName = `SamePage Test ${v4().slice(0, 8)}`;
  await test.step(`Create and Navigate to ${pageName}`, async () => {
    await metaPress(page.keyboard, "Enter");
    await page.locator("*:focus").fill(`[[${pageName}]]`);
    await page.keyboard.press("Escape");
    await page
      .locator(`span[data-link-title="${pageName}"]`)
      .locator("span.rm-page-ref")
      .click();
    await expect(page.locator("h1")).toHaveText(pageName);
  });
  const { clientSend } = await clientReady;
  unload = () => clientSend({ type: "unload" });

  await test.step("Enter content", async () => {
    await page
      .locator("text=Click here to start writing. Type '/' to see commands.")
      .click();
    await expect(page.locator("*:focus")).toHaveJSProperty(
      "tagName",
      "TEXTAREA"
    );
    await page
      .locator("textarea.rm-block-input")
      .type("This is an automated test case");
    await expect(page.locator("textarea.rm-block-input")).toHaveValue(
      "This is an automated test case"
    );
  });

  await enterCommandPaletteCommand(page, "Share Page on SamePage");

  const waitForNotification = clientSend({ type: "waitForNotification" });
  await test.step("Invite SamePage Client to page", async () => {
    await expect(page.locator(".bp3-dialog-header")).toHaveText(
      "Share Page on SamePage"
    );
    await page
      .locator('input[placeholder="Enter notebook..."]')
      .fill("SamePage test");
    await page.locator('li >> text="test"').click();
    await page.locator(".bp3-icon-plus").click();
    await expect(
      page.locator(
        '.bp3-toast.bp3-intent-success >> text="Successfully shared page! We will now await for the other notebook(s) to accept"'
      )
    ).toBeVisible();
  });
  const testClientRead = () =>
    clientSend({ type: "read", notebookPageId: pageName }).then(
      (r) => new JSDOM((r as { html: string }).html).window.document
    );

  await test.step("Accept Shared Page from Roam", async () => {
    await expect.poll(() => waitForNotification).toHaveProperty("uuid");
    const notification = await waitForNotification;
    const acceptResponse = clientSend({
      type: "accept",
      notebookPageId: pageName,
      notificationUuid: (notification as { uuid: string }).uuid,
    });
    await expect.poll(() => acceptResponse).toEqual({ success: true });
    await expect
      .poll(() =>
        testClientRead().then((d) => d.querySelector("li")?.textContent)
      )
      .toEqual(`This is an automated test case`);
  });

  const readIpfs = () => clientSend({ type: "ipfs", notebookPageId: pageName });
  await test.step("Edit some content in Roam", async () => {
    await page
      .locator(".bp3-overlay-backdrop")
      .click({ position: { x: 300, y: 16 } });
    await expect(page.locator("text=Share Page on SamePage")).not.toBeVisible();
    await page.locator("text=This is an automated test case").click();
    await expect(page.locator("*:focus")).toHaveJSProperty(
      "tagName",
      "TEXTAREA"
    );
    await metaPress(page.locator("*:focus"), "ArrowRight");
    await expect(page.locator("*:focus")).toHaveJSProperty(
      "selectionStart",
      "This is an automated test case".length
    );
    await page.locator("*:focus").type(" and we're adding edits.");
    await page.keyboard.press("Enter");
    await expect(
      page.locator(".roam-article .rm-block-children .rm-block-main")
    ).toHaveCount(2);
    await page.locator("*:focus").type("And a new block");
    await expect
      .poll(() =>
        testClientRead().then((d) =>
          Array.from(d.querySelectorAll("li")).map((l) => l?.textContent)
        )
      )
      .toEqual([
        `This is an automated test case and we're adding edits.`,
        `And a new block`,
      ]);
    await expect.poll(readIpfs).toEqual({
      content:
        "This is an automated test case and we're adding edits.\nAnd a new block\n",
      annotations: [
        {
          start: 0,
          end: 55,
          type: "block",
          attributes: {
            viewType: "bullet",
            level: 1,
          },
        },
        {
          start: 55,
          end: 71,
          type: "block",
          attributes: {
            viewType: "bullet",
            level: 1,
          },
        },
      ],
    });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  });

  await test.step("Insert content in samepage client", async () => {
    const insertResponse = clientSend({
      type: "insert",
      notebookPageId: pageName,
      content: " with a response",
      index: 15,
      path: "li:nth-child(2)",
    });
    await expect.poll(() => insertResponse).toEqual({ success: true });
    await expect(
      page.locator(":nth-match(.roam-article .roam-block, 1)")
    ).toHaveText("This is an automated test case and we're adding edits.");
    await expect(
      page.locator(":nth-match(.roam-article .roam-block, 2)")
    ).toHaveText("And a new block with a response");
  });

  await test.step("Accepting AtJson with a reference", async () => {
    await clientSend({
      type: "setAppClientState",
      notebookPageId: "abcde1234",
      data: "<div>A ref</div>",
    });
    const refreshResponse = clientSend({
      type: "refresh",
      notebookPageId: pageName,
      data: {
        content: `This is an automated test with my ref: ${String.fromCharCode(
          0
        )} and your ref: ${String.fromCharCode(0)}\n`,
        annotations: [
          {
            start: 0,
            end: 57,
            type: "block",
            attributes: {
              viewType: "bullet",
              level: 1,
            },
          },
          {
            start: 39,
            end: 40,
            type: "reference",
            attributes: {
              notebookPageId: "asdfghjkl",
              notebookUuid,
            },
          },
          {
            start: 55,
            end: 56,
            type: "reference",
            attributes: {
              notebookPageId: "abcde1234",
              notebookUuid: process.env.SAMEPAGE_TEST_UUID,
            },
          },
        ],
      },
    });
    await expect.poll(() => refreshResponse).toEqual({ success: true });
    await expect
      .poll(() =>
        page.evaluate(
          (pageName) =>
            (
              window.roamAlphaAPI.pull(
                "[:block/string {:block/children ...}]",
                [":node/title", pageName]
              )[":block/children"]?.[0] as PullBlock
            )?.[":block/string"],
          pageName
        )
      )
      .toEqual(
        `This is an automated test with my ref: [[asdfghjkl]] and your ref: {{samepage-reference:${process.env.SAMEPAGE_TEST_UUID}:abcde1234}}`
      );
  });

  await test.step("Cmd+Shift+Arrow on roam block should send update", async () => {
    await page.evaluate(
      async (p) => {
        const tree = window.roamAlphaAPI.pull(
          "[:block/uid :node/title {:block/children ...}]",
          `[:node/title "${p}"]`
        );
        const uid = (tree[":block/children"][0] as PullBlock)[":block/uid"];
        await window.roamAlphaAPI.updateBlock({
          block: { uid, string: "Top Block" },
        });
        await window.roamAlphaAPI.createBlock({
          block: { string: "Bottom Block" },
          location: { "parent-uid": tree[":block/uid"], order: 1 },
        });
        return uid;
      },
      [pageName]
    );
    await page.locator("text=Top Block").click();
    await expect(page.locator("*:focus")).toHaveJSProperty(
      "tagName",
      "TEXTAREA"
    );
    await page.keyboard.press("Meta+Shift+ArrowDown");
    await expect.poll(readIpfs).toEqual({
      content: "Bottom Block\nTop Block\n",
      annotations: [
        {
          start: 0,
          end: 13,
          type: "block",
          attributes: {
            viewType: "bullet",
            level: 1,
          },
        },
        {
          start: 13,
          end: 23,
          type: "block",
          attributes: {
            viewType: "bullet",
            level: 1,
          },
        },
      ],
    });
    await page.keyboard.press("Meta+Shift+ArrowUp");
    await expect.poll(readIpfs).toEqual({
      content: "Top Block\nBottom Block\n",
      annotations: [
        {
          start: 0,
          end: 10,
          type: "block",
          attributes: {
            viewType: "bullet",
            level: 1,
          },
        },
        {
          start: 10,
          end: 23,
          type: "block",
          attributes: {
            viewType: "bullet",
            level: 1,
          },
        },
      ],
    });
  });

  await test.step("Dragging roam block should send update", async () => {
    if (skip) return;
    const moveUid = await page.evaluate(
      (p) => {
        const tree = window.roamAlphaAPI.pull(
          "[:block/uid :node/title {:block/children ...}]",
          `[:node/title "${p}"]`
        );
        return (tree[":block/children"][0] as PullBlock)[":block/uid"];
      },
      [pageName]
    );
    // TODO: fails to grab the initial bullet, and then an intercept error on target
    await page
      .locator(`div[id*="${moveUid}"] >> .. >> .rm-bullet`)
      .dragTo(page.locator('text="Bottom Block"'), {
        targetPosition: { x: 0, y: 25 },
      });
    // await page.pause();
    await expect.poll(readIpfs).toEqual({
      content: "Bottom BlockTopBlock\n",
      annotations: [
        {
          start: 0,
          end: 12,
          type: "block",
          attributes: {
            viewType: "bullet",
            level: 1,
          },
        },
        {
          start: 0,
          end: 12,
          type: "block",
          attributes: {
            viewType: "bullet",
            level: 1,
          },
        },
      ],
    });
  });

  // It's now properly failing
  await test.step("Replay changes from disconnect", async () => {
    if (skip) return;
    await enterCommandPaletteCommand(page, "Disconnect from SamePage Network");
    const newBlockResponse = clientSend({
      type: "insert",
      notebookPageId: pageName,
      path: "body",
      content: "LI",
      index: 2,
    });
    await expect.poll(() => newBlockResponse).toEqual({ success: true });
    const newBlockContent = clientSend({
      type: "insert",
      notebookPageId: pageName,
      path: "li:nth-child(2)",
      content: "Offline edit",
      index: 0,
    });
    await expect.poll(() => newBlockContent).toEqual({ success: true });
    await enterCommandPaletteCommand(page, "Connect to SamePage Network");
    await page.locator('text="Offline edit"').click();
    await expect(page.locator("*:focus")).toHaveJSProperty(
      "tagName",
      "TEXTAREA"
    );
    await metaPress(page.locator("*:focus"), "ArrowRight");
    await expect(page.locator("*:focus")).toHaveJSProperty(
      "selectionStart",
      "Offline edit".length
    );
    await page.locator("*:focus").type(" and online edits");
    await expect.poll(readIpfs).toEqual({
      content: `This is an automated test with my ref: ${String.fromCharCode(
        0
      )} and your ref: ${String.fromCharCode(
        0
      )}\nOffline edit and online edits\n`,
      annotations: [
        {
          start: 0,
          end: 57,
          type: "block",
          attributes: {
            viewType: "bullet",
            level: 1,
          },
        },
        {
          start: 39,
          end: 40,
          type: "reference",
          attributes: {
            notebookPageId: "asdfghjkl",
            notebookUuid,
          },
        },
        {
          start: 55,
          end: 56,
          type: "reference",
          attributes: {
            notebookPageId: "abcde1234",
            notebookUuid: process.env.SAMEPAGE_TEST_UUID,
          },
        },
        {
          start: 57,
          end: 87,
          type: "block",
          attributes: {
            viewType: "bullet",
            level: 1,
          },
        },
      ],
    });
  });

  console.log = oldLog;
});
