#! /usr/bin/env node

import * as fs from "fs";
import { createHash } from "node:crypto";

import fetch from "node-fetch";
import jsdom from "jsdom";

// disable css parsing and its console noise monkey-patch,
// c/o https://github.com/jsdom/jsdom/issues/2005#issuecomment-1496469115
import { implementation } from 'jsdom/lib/jsdom/living/nodes/HTMLStyleElement-impl.js';
implementation.prototype._updateAStyleBlock = () => {};

const { JSDOM } = jsdom;

const decodeCdx = (cdx) => {
    const fields = cdx.shift();
    return cdx.map(r => Object.fromEntries(fields.map((f, i) => [f, r[i]])));
};

/** @type {<T = unknown>(url: string) => Promise<T | undefined>} */
const fetchJson = async (url) => {
    const res = await fetch(url);
    if (res.status !== 200) return;
    return await res.json();
};

/** @type {(url: string) => Promise<string | undefined>} */
const curl = async (url) => {
    const res = await fetch(url);
    if (res.status !== 200) return;
    return await res.text();
};

const utc2date = (t) => {
    const [, Y, M, D, h, m, s] = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(t) || [];
    return new Date(Date.parse(`${Y}-${M}-${D}T${h}:${m}:${s}Z`));
};

/** @type {(url: string) => Promise<Array<{ time: string, url: string, digest: string }>>} */
const getArchived = async (url) => {
    const fl = "timestamp,original,statuscode,digest";
    const cdxUrl = `https://web.archive.org/cdx/search/cdx?url=${url}&fl=${fl}&output=json`;
    const cdx = await fetchJson(cdxUrl);
    let ok = decodeCdx(cdx).filter(r => r.statuscode == 200);
    ok = uniq(ok, "digest"); // dedupe content
    ok = uniq(ok, "timestamp"); // dedupe time of fetch
    return ok.map(({ original, statuscode, timestamp, ...r}) => ({
        time: utc2date(timestamp).toLocaleString("sv-se"),
        url: `https://web.archive.org/web/${timestamp}/${original}`,
        ...r
    }));
}

/** @type {<T>(arr: T[], field: keyof T) => T[]} */
const uniq = (arr, field) => {
    const seen = {}, res = [];
    for (const row of arr) {
        const key = row[field];
        if (seen[key]) continue;
        seen[key] = true;
        res.push(row);
    }
    return res;
};

const hasText = (s) => !!s && !!s.trim();

/** @type {(html: string) => string | undefined} */
const mdFromHtml = (html) => {
    const roots = [".wpb_wrapper", ".hb-main-content"];
    const { document } = new JSDOM(html).window;

    const isH = (e) => e.firstElementChild?.nodeName === "B";
    const t = (e) => e.textContent.replace(/\s+/g, " ").trim();
    const h = (e) => "".padStart(Number(e.nodeName.slice(1)), "#") + " " + t(e);
    const p = (e) => `${isH(e) ? "## " : ""}${t(e)}${isH(e) ? "" : "\n"}`;
    /** @type {Record<string, (e: JSDOM.HtmlElement) => string>} */
    const el = {
        H1: h,
        H2: h,
        H3: h,
        H4: h,
        H5: h,
        H6: h,
        P: p,
        LI: (e) => `* ${p(e)}`,
    }
    for (const root of roots) {
        const doc = document.querySelector(root);
        if (!doc) continue;
        const els = doc.querySelectorAll("h1, h2, h3, h4, h5, h6, p, li");
        const md = [];
        const seen = [];
        const alreadySeen = (e) => seen.indexOf(e) !== -1;
        const ancestorsOrSelf = (e) => {
            const all = [e];
            while (e.parentNode) {
                all.push(e = e.parentNode);
            }
            return all;
        };
        for (const e of Array.from(els)) {
            if (ancestorsOrSelf(e).some(alreadySeen)) continue;
            seen.push(e);
            md.push(el[e.nodeName](e));
        }
        return md.filter(hasText).join("\n").trim() + "\n";
    }
};

const encoder = new TextEncoder("utf8");
const utf8 = (s) => encoder.encode(s);
const sha256 = (s) =>
    createHash("sha256").update(utf8(s)).digest("base64url");

const dedupArchiveOrgMarkup = (html) =>
    html.replace(
        /(<!--\s+FILE ARCHIVED ON.*?) AND RETRIEVED FROM THE\n.*/gm,
        "$1"
    ).replace(
        /<!--\s+playback timings .ms.:[\s\S]*?-->/gm,
        ""
    );

/** @type {(urlToSave: string) => Promise<void>} */
const archive = async (urlToSave) => {
    const {hostname, pathname} = new URL(urlToSave);
    let dir = pathname.replace(/^\/*|\/.*$/g, "");
    const versions = await getArchived(urlToSave);
    if (!Array.isArray(versions) || !versions.length) return;

    try { fs.mkdirSync(hostname); } catch(e) {}
    dir = `${hostname}/${dir}`;
    try { fs.mkdirSync(dir); } catch(e) {}
    /** @type (hash: string) => string */
    const getMarkFilename = (hash, time) => `${dir}/${time} ${hash}.md`;
    /** @type (hash: string) => string */
    const getHtmlFilename = (hash, time) => `${dir}/${time}-${hash}.html`;

    for (const {time, url, digest} of versions) {
        const t = time.replace(/:/g, "");
        const htmlFilename = getHtmlFilename(digest, t);

        let html;
        try {
            html = fs.readFileSync(htmlFilename, "utf8");
            console.log(`Loaded ${time} version from ${htmlFilename}`);
        } catch (e) {
            console.log(`…fetch ${time} version from ${url}`);
            html = await curl(url);
        }
        if (html) {
            html = dedupArchiveOrgMarkup(html);
            fs.writeFileSync(htmlFilename, html);
            const md = mdFromHtml(html);
            if (md) {
                const hash = sha256(md);
                fs.writeFileSync(getMarkFilename(hash, t), md);
            }
        }
    }
};

const {argv} = process;
if (argv.length < 3) {
    console.warn(`usage: index.js <url-to-fetch>`);
    process.exit(1);
} else {
    for (const url of argv.slice(2)) {
        await archive(url);
    }
    process.exit(0);
}
