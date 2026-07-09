#!/usr/bin/env node
// Headless verification for the falling-boxes example.
//
// 1. Ensures the wasm core is built (scripts/build-wasm.sh, idempotent) and builds the Vite app.
// 2. Boots `vite preview` and drives it with a real Chromium-family browser (headless).
// 3. Waits for ~8s of *simulation* time (window.__sim.time, driven by the fixed-step accumulator
//    in src/main.ts -- NOT wall-clock time) to elapse.
// 4. Asserts: zero console errors, no tunneling (every box's Y stays above the ground plane), and
//    the pile has come to rest (a majority of boxes asleep, or velocities near zero).
// 5. Writes verify/screenshot.png and exits 0 on pass, 1 on any failed assertion.
//
// Browser selection: tries puppeteer-core against a system Google Chrome install first (no
// download needed); if that's unavailable on this machine, falls back to the full `puppeteer`
// package, which downloads and drives its own bundled Chromium. Prints which flavor ran.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname( fileURLToPath( import.meta.url ) );
const exampleRoot = here;
const repoRoot = path.resolve( exampleRoot, "..", ".." );

const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PREVIEW_PORT = 4174;
const URL = `http://localhost:${ PREVIEW_PORT }/`;
const OUT_DIR = path.join( exampleRoot, "verify" );
const SIM_SECONDS_TO_WAIT = 8;
const NEAR_ZERO_VELOCITY = 0.05; // m/s
const REST_TIMEOUT_MS = 30_000;

const sleep = ( ms ) => new Promise( ( r ) => setTimeout( r, ms ) );

function run( cmd, args, opts = {} ) {
	console.log( `[verify] $ ${ cmd } ${ args.join( " " ) }` );
	const res = spawnSync( cmd, args, { stdio: "inherit", ...opts } );
	if ( res.status !== 0 ) {
		throw new Error( `${ cmd } ${ args.join( " " ) } exited ${ res.status }` );
	}
}

function waitForHttp( url, timeoutMs = 30_000 ) {
	return new Promise( ( resolve, reject ) => {
		const start = Date.now();
		( async function poll() {
			while ( Date.now() - start < timeoutMs ) {
				try {
					const r = await fetch( url );
					if ( r.ok ) return resolve( true );
				} catch {
					// preview server not up yet
				}
				await sleep( 300 );
			}
			reject( new Error( "vite preview server never came up" ) );
		} )();
	} );
}

async function launchBrowser() {
	if ( existsSync( CHROME_PATH ) ) {
		try {
			const { default: puppeteerCore } = await import( "puppeteer-core" );
			const browser = await puppeteerCore.launch( { headless: true, executablePath: CHROME_PATH } );
			return { browser, flavor: `puppeteer-core + system Chrome (${ CHROME_PATH })` };
		} catch ( err ) {
			console.warn( "[verify] puppeteer-core + system Chrome failed, falling back:", err.message );
		}
	} else {
		console.warn( `[verify] system Chrome not found at ${ CHROME_PATH } -- falling back to full puppeteer` );
	}
	const { default: puppeteer } = await import( "puppeteer" );
	const browser = await puppeteer.launch( { headless: true } );
	return { browser, flavor: "full puppeteer (bundled Chromium download)" };
}

async function main() {
	mkdirSync( OUT_DIR, { recursive: true } );

	console.log( "[verify] ensuring wasm core is built..." );
	run( path.join( repoRoot, "scripts", "build-wasm.sh" ), [], { cwd: repoRoot } );

	if ( !existsSync( path.join( exampleRoot, "node_modules" ) ) ) {
		console.log( "[verify] installing example dependencies..." );
		run( "npm", ["install"], { cwd: exampleRoot } );
	}

	console.log( "[verify] building example app..." );
	run( "npm", ["run", "build"], { cwd: exampleRoot } );

	console.log( "[verify] starting vite preview server..." );
	const preview = spawn( "npx", ["vite", "preview", "--port", String( PREVIEW_PORT ), "--strictPort"], {
		cwd: exampleRoot,
		stdio: "pipe",
	} );
	preview.stdout.on( "data", ( d ) => process.stdout.write( `[preview] ${ d }` ) );
	preview.stderr.on( "data", ( d ) => process.stderr.write( `[preview] ${ d }` ) );
	await waitForHttp( URL );
	console.log( "[verify] preview server up at", URL );

	const failures = [];
	let browser;
	let flavor = "(none)";

	try {
		( { browser, flavor } = await launchBrowser() );
		console.log( "[verify] browser flavor:", flavor );

		const page = await browser.newPage();
		await page.setViewport( { width: 1280, height: 800 } );

		const consoleErrors = [];
		page.on( "console", ( msg ) => {
			if ( msg.type() === "error" ) consoleErrors.push( msg.text() );
		} );
		page.on( "pageerror", ( err ) => consoleErrors.push( String( err ) ) );

		await page.goto( URL, { waitUntil: "load" } );

		// Wait for window.__sim to exist (the app finished async wasm init).
		await page.waitForFunction( "!!window.__sim", { timeout: 15_000 } );

		// Let sim.time (fixed-step simulation time, not wall clock) reach SIM_SECONDS_TO_WAIT.
		const simStart = Date.now();
		let lastTime = 0;
		while ( lastTime < SIM_SECONDS_TO_WAIT ) {
			if ( Date.now() - simStart > REST_TIMEOUT_MS ) {
				throw new Error( `sim.time only reached ${ lastTime.toFixed( 2 ) }s within ${ REST_TIMEOUT_MS }ms wall time` );
			}
			lastTime = await page.evaluate( () => window.__sim.time );
			if ( lastTime < SIM_SECONDS_TO_WAIT ) await sleep( 200 );
		}
		console.log( `[verify] sim.time reached ${ lastTime.toFixed( 2 ) }s` );

		const stats = await page.evaluate( () => ( {
			sleepingCount: window.__sim.sleepingCount,
			maxAbsVelocity: window.__sim.maxAbsVelocity,
			bodyYs: window.__sim.bodyYs(),
		} ) );

		console.log( "[verify] stats:", JSON.stringify( { sleepingCount: stats.sleepingCount, maxAbsVelocity: stats.maxAbsVelocity, boxCount: stats.bodyYs.length } ) );

		// ---- Assertions ----
		if ( consoleErrors.length > 0 ) {
			failures.push( `${ consoleErrors.length } console error(s): ${ consoleErrors.slice( 0, 5 ).join( " | " ) }` );
		}

		const belowGround = stats.bodyYs.filter( ( y ) => y <= 0 );
		if ( belowGround.length > 0 ) {
			failures.push( `${ belowGround.length } box(es) at/below ground (y <= 0) -- possible tunneling` );
		}

		const boxCount = stats.bodyYs.length;
		const majorityAsleep = stats.sleepingCount >= boxCount / 2;
		const nearZeroVelocity = stats.maxAbsVelocity <= NEAR_ZERO_VELOCITY;
		if ( !majorityAsleep && !nearZeroVelocity ) {
			failures.push(
				`pile has not settled: sleepingCount=${ stats.sleepingCount }/${ boxCount }, ` +
				`maxAbsVelocity=${ stats.maxAbsVelocity.toFixed( 4 ) } m/s (threshold ${ NEAR_ZERO_VELOCITY })`
			);
		}

		const screenshotPath = path.join( OUT_DIR, "screenshot.png" );
		await page.screenshot( { path: screenshotPath } );
		console.log( "[verify] wrote", screenshotPath );

		writeFileSync(
			path.join( OUT_DIR, "report.json" ),
			JSON.stringify( { flavor, simTime: lastTime, stats, consoleErrors, failures, timestamp: new Date().toISOString() }, null, 2 )
		);

		await page.close();
	} finally {
		if ( browser ) await browser.close();
		preview.kill();
	}

	console.log( "\n[verify] browser flavor used:", flavor );
	if ( failures.length > 0 ) {
		console.error( "\n[verify] FAILED:" );
		for ( const f of failures ) console.error( "  -", f );
		process.exit( 1 );
	}

	console.log( "[verify] PASSED" );
	process.exit( 0 );
}

main().catch( ( err ) => {
	console.error( "[verify] ERROR", err );
	process.exit( 1 );
} );
