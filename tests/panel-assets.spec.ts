// @ts-nocheck
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
const html = readFileSync(
  new URL("../panel/assets.html", import.meta.url),
  "utf8",
);
const script = html.slice(
  html.indexOf("<script>") + 8,
  html.lastIndexOf("</script>"),
);
class Element {
  value = "";
  textContent = "";
  disabled = false;
  hidden = false;
  className = "";
  dataset = {};
  attrs = {};
  children = [];
  markup = "";
  tagName = "";
  onclick;
  oninput;
  onchange;
  constructor(
    tag = "",
    private register = (_: string, __: Element) => {},
  ) {
    this.tagName = tag;
  }
  set innerHTML(text) {
    this.markup = text;
    this.children = [];
    for (const match of text.matchAll(
      /<(input|textarea|div|button|p|b)[^>]*id="([^"]+)"([^>]*)>([^<]*)/g,
    )) {
      const e = new Element(match[1], this.register);
      e.value = (
        match[3].match(/value="([^"]*)"/)?.[1] ??
        (match[1] === "textarea" ? match[4] : "")
      )
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
      this.register(match[2], e);
    }
  }
  get innerHTML() {
    return this.markup;
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  appendChild(c) {
    this.children.push(c);
    return c;
  }
  replaceChildren(...c) {
    this.children = c;
    this.markup = "";
    this.textContent = "";
  }
}
const asset = (id, name = "Alpha") => ({
  id,
  name,
  description: "safe <script>bad</script>",
  kind: "document",
  status: "active",
  archived: false,
  revision: 2,
  updatedAt: "2026-01-01",
  source: {
    ticketId: "t-1",
    ticketTitle: "Ticket one",
    availability: "available",
  },
  managed: true,
  tags: ["one"],
});
const response = (v, ok = true) => ({
  ok,
  status: ok ? 200 : 409,
  json: async () => structuredClone(v),
});
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function fixture() {
  const nodes = {};
  const register = (id, e) => {
    nodes[id] = e;
  };
  const get = (id) => nodes[id] || (nodes[id] = new Element("", register));
  const assets = [
    asset("a1"),
    { ...asset("a2", "Beta"), status: "candidate", kind: "dataset" },
  ];
  const calls = [];
  const events = {};
  let content = {
    path: "a.txt",
    text: true,
    base64: Buffer.from("你好 <script>alert(1)</script>").toString("base64"),
    mimeType: "text/plain",
    size: 30,
  };
  const fetch = vi.fn(async (url, opt = {}) => {
    calls.push([url, opt]);
    if (url.endsWith("/relations")) return response({related:[{id:"a2",name:"Beta",reason:"同一任务产出"}],references:[{ticketId:"t1",title:"Task one",revision:2,state:"selected",reason:"已选择，不表示已读取"}]});
    if (url.includes("/content")) return response(content);
    if (url.includes("/assets?")) return response({ assets });
    if (url.endsWith("/assets/import")) return response(assets[0]);
    const a = assets.find((a) => url === "/ordin/api/assets/" + a.id);
    if (!a) throw Error("unexpected " + url);
    if (opt.method === "PATCH") {
      Object.assign(a, JSON.parse(opt.body), { revision: a.revision + 1 });
      return response(a);
    }
    return response(a);
  });
  const window = {
    parent: { postMessage: vi.fn() },
    addEventListener: (name, cb) => {
      events[name] = cb;
    },
  };
  const urls = {
    createObjectURL: vi.fn(() => "blob:1"),
    revokeObjectURL: vi.fn(),
  };
  [
    "query",
    "kind",
    "status",
    "refresh",
    "import-open",
    "import-panel",
    "import-name",
    "import-kind",
    "import-description",
    "import-text",
    "import-submit",
    "import-cancel",
    "error",
  ].forEach((id) => get(id));
  runInNewContext(script, {
    document: {
      getElementById: get,
      createElement: (tag) => new Element(tag, register),
    },
    window,
    location: { origin: "http://ordin.test" },
    fetch,
    URL: urls,
    Blob,
    TextDecoder,
    Uint8Array,
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    URLSearchParams,
    console,
  });
  return {
    nodes,
    window,
    api: window.AssetLibrary,
    fetch,
    calls,
    assets,
    urls,
    events,
    content: (value) => {
      content = value;
    },
  };
}
describe("asset library actual JavaScript", () => {
  it("renders and navigates explicit relations, labels selection honestly and tolerates relation-only failures", async()=>{
    const f=fixture();await f.api.init();await f.api.select("a1");
    const related=f.nodes.detail.children[0];
    expect(related.children[0].textContent).toContain("同一任务产出");
    expect(f.nodes.detail.children[1].children[1].textContent).toContain("尚不能据此确认执行端已读取");
    await related.children[0].onclick();expect(f.api.state.selected).toBe("a2");
    const original=f.fetch.getMockImplementation();f.fetch.mockImplementation(async(url,opt)=>url.endsWith("/relations")?response({error:"relation offline"},false):original(url,opt));
    await f.api.select("a1");expect(f.api.state.detail.id).toBe("a1");
    expect(f.nodes.detail.children[0].children[0].textContent).toContain("关系暂不可用：relation offline");
    await f.nodes["load-content"].onclick();expect(f.nodes.preview.hidden).toBe(false);
  });
  it("opens a list asset preview and reports legacy unmanaged errors honestly", async () => {
    const f = fixture();
    f.assets[0].managed = false;
    await f.api.init();
    await f.nodes.list.children[0].onclick();
    expect(f.nodes.preview.hidden).toBe(false);
    expect(f.nodes.detail.innerHTML).toContain("旧资产尚未独立保存");
    f.fetch.mockImplementationOnce(async () => response({ error: "asset content unavailable" }, false));
    await f.nodes["load-content"].onclick();
    expect(f.nodes["preview-body"].textContent).toContain("asset content unavailable");
  });
  it("searches kinds/statuses, renders short descriptions and escapes untrusted values", async () => {
    const f = fixture();
    await f.api.init();
    expect(f.nodes.list.children).toHaveLength(2);
    expect(f.nodes.list.children[0].innerHTML).toContain("&lt;script&gt;");
    f.nodes.status.value = "candidate";
    f.nodes.status.onchange();
    expect(f.nodes.list.children).toHaveLength(1);
    expect(f.nodes.list.children[0].dataset.id).toBe("a2");
    f.nodes.kind.value = "dataset";
    await f.nodes.kind.onchange();
    expect(f.calls.at(-1)[0]).toContain("kind=dataset");
    expect(f.calls.at(-1)[0]).not.toContain("status=");
    f.nodes.query.value = "Beta";
    await f.nodes.query.oninput();
    expect(f.calls.at(-1)[0]).toContain("query=Beta");
    expect(f.nodes.list.children).toHaveLength(1);
  });
  it("shows safe UTF-8 text and closes the preview", async () => {
    const f = fixture();
    await f.api.init();
    await f.api.select("a1");
    await f.nodes["load-content"].onclick();
    expect(f.nodes["preview-body"].children[0].textContent).toBe(
      "你好 <script>alert(1)</script>",
    );
    expect(f.nodes["preview-body"].children[0].innerHTML).toBe("");
    f.nodes["preview-close"].onclick();
    expect(f.nodes.preview.hidden).toBe(true);
  });
  it("downloads binary HTML/SVG without execution and revokes URLs on close/navigation", async () => {
    const f = fixture();
    await f.api.init();
    await f.api.select("a1");
    for (const mimeType of ["text/html", "image/svg+xml", "application/pdf"]) {
      f.content({
        text: false,
        base64: Buffer.from("<svg onload=alert(1)>").toString("base64"),
        mimeType,
      });
      await f.nodes["load-content"].onclick();
      expect(f.nodes["preview-body"].children[0].tagName).toBe("a");
      expect(f.nodes["preview-body"].children[0].href).toBe("blob:1");
      f.nodes["preview-close"].onclick();
    }
    expect(f.urls.revokeObjectURL).toHaveBeenCalledTimes(3);
    await f.nodes["load-content"].onclick();
    await f.api.select("a2");
    expect(f.urls.revokeObjectURL).toHaveBeenCalledTimes(4);
    await f.nodes["load-content"].onclick();
    f.events.pagehide();
    expect(f.urls.revokeObjectURL).toHaveBeenCalledTimes(5);
  });
  it("only renders known raster images", async () => {
    const f = fixture();
    await f.api.init();
    await f.api.select("a1");
    f.content({ text: false, base64: "AA==", mimeType: "image/png" });
    await f.nodes["load-content"].onclick();
    expect(f.nodes["preview-body"].children[0].tagName).toBe("img");
  });
  it("navigates a source through the parent without accepting a candidate", async () => {
    const f = fixture();
    await f.api.init();
    await f.api.select("a2");
    f.nodes["asset-source"].children[0].onclick();
    expect(f.window.parent.postMessage).toHaveBeenCalledWith(
      { type: "ordin:navigate", tab: "workspace", ticketId: "t-1" },
      "http://ordin.test",
    );
    expect(f.nodes.detail.innerHTML).toContain("候选");
    expect(f.nodes.detail.innerHTML).toContain("尚未表示验收通过");
    expect(f.calls.every(([, o]) => !o.method)).toBe(true);
    f.assets[1].source.availability = "deleted";
    await f.api.select("a2");
    expect(f.nodes["asset-source"].children[0]).toContain("已删除");
  });
  it("keeps previous data on network/malformed errors and prevents stale list/detail commits", async () => {
    const f = fixture();
    await f.api.init();
    f.fetch.mockImplementationOnce(async () =>
      response({ error: "offline" }, false),
    );
    await f.api.refresh();
    expect(f.nodes.list.children).toHaveLength(2);
    expect(f.nodes.error.textContent).toContain("上次内容");
    f.fetch.mockImplementationOnce(async () => response({ bad: [] }));
    await f.api.refresh();
    expect(f.nodes.error.textContent).toContain("格式");
    const list = deferred();
    f.fetch.mockImplementationOnce(() => list.promise);
    const old = f.api.refresh();
    await f.api.refresh();
    list.resolve(response({ assets: [asset("stale")] }));
    await old;
    expect(f.nodes.list.children[0].dataset.id).toBe("a1");
    const detail = deferred();
    f.fetch.mockImplementationOnce(() => detail.promise);
    const previous = f.api.select("a1");
    await f.api.select("a2");
    detail.resolve(response(asset("a1", "STALE")));
    await previous;
    expect(f.nodes.detail.innerHTML).toContain("Beta");
    expect(f.nodes.detail.innerHTML).not.toContain("STALE");
  });
  it("ignores delayed previews after close or a newer selection and shows content errors", async () => {
    const f = fixture();
    await f.api.init();
    await f.api.select("a1");
    const pending = deferred();
    f.fetch.mockImplementationOnce(() => pending.promise);
    const old = f.nodes["load-content"].onclick();
    f.nodes["preview-close"].onclick();
    pending.resolve(response({ text: true, base64: "U1RBTEU=" }));
    await old;
    expect(f.nodes.preview.hidden).toBe(true);
    expect(f.nodes["preview-body"].children).toHaveLength(0);
    f.fetch.mockImplementationOnce(async () =>
      response({ error: "content offline" }, false),
    );
    await f.nodes["load-content"].onclick();
    expect(f.nodes["preview-body"].textContent).toContain("content offline");
  });
  it("preserves metadata drafts on error/switch, sends expectedRevision, and guards delayed writes", async () => {
    const f = fixture();
    await f.api.init();
    await f.api.select("a1");
    f.nodes["edit-name"].value = "Draft";
    f.nodes["edit-tags"].value = "a, b";
    f.fetch.mockImplementationOnce(async () =>
      response({ error: "conflict" }, false),
    );
    await f.nodes["save-meta"].onclick();
    expect(f.nodes["edit-name"].value).toBe("Draft");
    expect(f.nodes.error.textContent).toContain("conflict");
    await f.api.select("a2");
    await f.api.select("a1");
    expect(f.nodes["edit-name"].value).toBe("Draft");
    const gate = deferred();
    f.fetch.mockImplementationOnce(() => gate.promise);
    const write = f.nodes["save-meta"].onclick();
    await f.nodes["save-meta"].onclick();
    const call = f.fetch.mock.calls.find(
      ([u, o]) =>
        u.endsWith("/assets/a1") &&
        o?.method === "PATCH" &&
        JSON.parse(o.body).name === "Draft",
    );
    expect(JSON.parse(call[1].body)).toEqual({
      expectedRevision: 2,
      name: "Draft",
      description: "safe <script>bad</script>",
      tags: ["a", "b"],
    });
    await f.api.select("a2");
    gate.resolve(response({ ...asset("a1"), name: "Draft", revision: 3 }));
    await write;
    expect(f.nodes.detail.innerHTML).toContain("Beta");
    await f.nodes["archive-asset"].onclick();
    expect(JSON.parse(f.calls.at(-1)[1].body)).toEqual({
      expectedRevision: 2,
      archived: true,
    });
  });
  it("sends import details with optional description, keeps failed drafts and shows honest empty state", async () => {
    const f = fixture();
    await f.api.init();
    f.nodes["import-name"].value = "N";
    f.nodes["import-text"].value = "正文";
    f.fetch.mockImplementationOnce(async () =>
      response({ error: "import offline" }, false),
    );
    await f.nodes["import-submit"].onclick();
    expect(f.nodes["import-text"].value).toBe("正文");
    await f.nodes["import-submit"].onclick();
    const call = f.calls.filter(([u]) => u.endsWith("/assets/import")).at(-1);
    expect(JSON.parse(call[1].body)).toEqual({
      text: "正文",
      name: "N",
      kind: "document",
      description: "",
      tags: [],
    });
    f.assets.length = 0;
    await f.api.refresh();
    expect(f.nodes.list.textContent).toBe("没有符合条件的资产。");
    expect(html).not.toContain("启用");
  });
});
