#! /usr/bin/env node

import * as fs from "fs";

import fetch from "node-fetch";

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

/** @type {(urlToSave: string) => Promise<void>} */
const archive = async (urlToSave) => {
    const {hostname, pathname} = new URL(urlToSave);
    let dir = pathname.replace(/^\/*|\/.*/, "");
    const versions = await getArchived(urlToSave);
    if (!Array.isArray(versions) || !versions.length) return;
    try { fs.mkdirSync(hostname); } catch(e) {}
    dir = `${hostname}/${dir}`;
    try { fs.mkdirSync(dir); } catch(e) {}
    for (const {time, url, digest} of versions) {
        console.log(`Fetching ${time} version from ${url}`);
        const html = await curl(url);
        if (html) {
            const filename = time.replace(/:/g, "");
            fs.writeFileSync(`${dir}/${filename}-${digest}.html`, html);
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
