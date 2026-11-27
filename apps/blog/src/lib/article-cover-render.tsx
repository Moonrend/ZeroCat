import path from "node:path";
import { readFile } from "node:fs/promises";
import satori from "satori";
import { truncate } from "./utils";
import {
  pickArticleCoverExcerptLines,
  type ArticleCoverInput,
} from "./article-cover-contract";

const coverFontPath = path.resolve(
  process.cwd(),
  "src",
  "assets",
  "fonts",
  "LXGWWenKaiLite-Medium.ttf"
);

const fontDataPromise = readFile(coverFontPath);

export async function renderArticleCoverDataUrl(input: ArticleCoverInput) {
  const coverFont = await fontDataPromise;
  const title = truncate((input.title || "未命名文章").trim(), 32);
  const excerptLines = pickArticleCoverExcerptLines(input);

  const svg = await satori(
    <div
      style={{
        display: "flex",
        height: "100%",
        width: "100%",
        padding: "84px 96px",
        background:
          "linear-gradient(135deg, #fcfcf7 0%, #f6f2e9 52%, #efe7d8 100%)",
        color: "#161616",
        fontFamily: "LXGW WenKai Lite",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          width: "100%",
          height: "100%",
        }}
      >
        <div
          style={{
            display: "flex",
            width: 160,
            height: 8,
            borderRadius: 999,
            background: "#d7c5a7",
          }}
        />

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
            gap: 30,
            maxWidth: 1220,
          }}
        >
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              textAlign: "left",
              fontSize: 112,
              lineHeight: 1.08,
              letterSpacing: "-0.045em",
              color: "#111111",
            }}
          >
            {title}
          </div>

          {excerptLines.length ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
                gap: 14,
                maxWidth: 980,
                fontSize: 34,
                lineHeight: 1.45,
                color: "rgba(17,17,17,0.72)",
                letterSpacing: "-0.02em",
              }}
            >
              {excerptLines.map((line, index) => (
                <div key={`${line}-${index}`} style={{ display: "flex" }}>
                  {line}
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            fontSize: 64,
            lineHeight: 1,
            letterSpacing: "0.08em",
            color: "rgba(17,17,17,0.45)",
          }}
        >
          ZeroCat Blog
        </div>
      </div>
    </div>,
    {
      width: 1600,
      height: 900,
      fonts: [
        {
          name: "LXGW WenKai Lite",
          data: coverFont,
          weight: 500,
          style: "normal",
        },
      ],
    }
  );

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
