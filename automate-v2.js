const puppeteer = require('puppeteer-core');
const readline = require('readline');
const fs = require('fs');
require('dotenv').config();

// Load events data
const eventsData = JSON.parse(fs.readFileSync('./events-data.json', 'utf8'));

// ===========================================
// CONFIGURATION
// ===========================================
const CONFIG = {
    locationSearch: process.env.LOCATION_SEARCH,
    locationResultIndex: parseInt(process.env.LOCATION_RESULT_INDEX ?? '1', 10),
    group: process.env.GROUP,
    hostedByCommunityAmbassador: process.env.HOSTED_BY_AMBASSADOR === 'true'
};

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function ask(question) {
    return new Promise(resolve => rl.question(question, resolve));
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// Parse event date/time from "2026/04/01 18:00:00"
function parseEventDateTime(localDateTime) {
    const [datePart, timePart] = localDateTime.split(' ');
    const [year, month, day] = datePart.split('/');
    const [hour, minute] = timePart.split(':');
    
    return {
        year: parseInt(year),
        month: parseInt(month),
        day: parseInt(day),
        hour: parseInt(hour),
        minute: parseInt(minute),
        date: new Date(year, month - 1, day, hour, minute)
    };
}

function formatDate(dt) {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${days[dt.date.getDay()]}, ${months[dt.month - 1]} ${dt.day}, ${dt.year}`;
}

function formatTime(dt) {
    let hour = dt.hour;
    const ampm = hour >= 12 ? 'PM' : 'AM';
    hour = hour % 12 || 12;
    return `${hour}:${String(dt.minute).padStart(2, '0')} ${ampm}`;
}

async function main() {
    console.log('=== Campfire Meetup Form Automation ===\n');
    
    const browser = await puppeteer.connect({
        browserURL: 'http://localhost:9222',
        defaultViewport: null
    });
    
    const pages = await browser.pages();
    const page = pages.find(p => p.url().includes('campfire.nianticlabs.com'));
    
    if (!page) {
        console.log('❌ Campfire tab not found! Please open the Create Meetup form first.');
        rl.close();
        return;
    }
    
    console.log('✓ Connected to Campfire\n');

    function shiftHours(dt, delta) {
        const d = new Date(dt.date);
        d.setHours(d.getHours() + delta);
        return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes(), date: d };
    }

    while (true) {
    // Display available events
    console.log('Available Live Events:');
    console.log('─'.repeat(50));
    eventsData.marketableCampfireLiveEvents.forEach((event, i) => {
        const date = event.localStartTime.split(' ')[0].replace(/\//g, '-');
        const time = event.localStartTime.split(' ')[1].substring(0, 5);
        console.log(`[${i + 1}] ${event.eventName}`);
        console.log(`    📅 ${date} at ${time}`);
    });
    console.log('─'.repeat(50));
    
    const eventNum = await ask('\nEnter event number to select (or "q" to quit): ');
    
    if (eventNum.toLowerCase() === 'q') {
        console.log('Cancelled.');
        break;
    }
    
    const eventIndex = parseInt(eventNum) - 1;
    if (isNaN(eventIndex) || eventIndex < 0 || eventIndex >= eventsData.marketableCampfireLiveEvents.length) {
        console.log('❌ Invalid event number, try again.');
        continue;
    }
    
    const selectedEvent = eventsData.marketableCampfireLiveEvents[eventIndex];
    const rawStart = parseEventDateTime(selectedEvent.localStartTime);
    const rawEnd   = parseEventDateTime(selectedEvent.localEndTime);

    const startDT = shiftHours(rawStart, -1);
    const endDT   = rawEnd;

    console.log(`\n✓ Selected: ${selectedEvent.eventName}`);
    console.log(`  Meetup Start: ${formatDate(startDT)} at ${formatTime(startDT)} (event start - 1h)`);
    console.log(`  Meetup End:   ${formatTime(endDT)} (event end, unchanged)`);
    console.log(`  Location: ${CONFIG.locationSearch} (result #${CONFIG.locationResultIndex + 1})`);
    console.log(`  Group: ${CONFIG.group}`);

    // =============================================
    // STEP 0: Open the Create Meetup form
    // =============================================
    console.log('\n0. Opening Create Meetup form...');

    // Click the profile avatar (top-right)
    const avatarClicked = await page.evaluate(() => {
        const avatar = document.querySelector('ion-avatar');
        if (avatar && avatar.getBoundingClientRect().width > 0) { avatar.click(); return true; }
        return false;
    });
    if (!avatarClicked) {
        console.log('   ⚠ Profile avatar not found — is the Campfire main page open?');
    } else {
        console.log('   ✓ Profile menu opened');
    }
    await sleep(1000);

    // Click "Create Meetup" from the dropdown
    const createMenuClicked = await page.evaluate(() => {
        for (const btn of document.querySelectorAll('ion-button')) {
            if (btn.textContent?.trim() === 'Create Meetup') {
                const r = btn.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) { btn.click(); return true; }
            }
        }
        return false;
    });
    if (createMenuClicked) {
        console.log('   ✓ Create Meetup form opening...');
    } else {
        console.log('   ⚠ Create Meetup option not found in menu');
    }

    // Wait for the form to open (poll for the Meetup Name input)
    for (let i = 0; i < 20; i++) {
        const formReady = await page.evaluate(() => !!document.querySelector('input[placeholder="Meetup Name"]'));
        if (formReady) break;
        await sleep(400);
    }
    console.log('   ✓ Form ready');

    const meetupStartTime = Date.now();

    console.log('\n📝 Filling form...\n');

    // Scroll to top before starting
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(500);

    // =============================================
    // STEP 1: Select Live Event
    // =============================================
    console.log(`1. Selecting Live Event "${selectedEvent.eventName}"...`);

    // Open the Live Event dropdown — it is near the bottom of the form, must scroll to it
    const liveEventFieldHandle = await page.evaluateHandle(() => {
        const spans = document.querySelectorAll('span');
        for (const span of spans) {
            if (span.textContent?.trim() === 'e.g. Community Day') {
                span.scrollIntoView({ behavior: 'instant', block: 'center' });
                return span.parentElement; // _K+nBtF-M9S div — the actual clickable button
            }
        }
        return null;
    });
    const liveEventFieldEl = liveEventFieldHandle.asElement();
    if (liveEventFieldEl) {
        await liveEventFieldEl.click();
        await liveEventFieldHandle.dispose();
        console.log(`   ✓ Opened Live Event dropdown`);
        await sleep(1000);

        // Events appear as SPAN._QBCrlHUfSb in the modal — find by exact text
        const liveEventOptionHandle = await page.evaluateHandle((eventName) => {
            // First try modal-specific class, then fall back to all spans
            for (const span of document.querySelectorAll('span._QBCrlHUfSb, span._5CBcT3-a7O')) {
                if (span.textContent.trim() === eventName) {
                    span.scrollIntoView({ behavior: 'instant', block: 'center' });
                    return span;
                }
            }
            return null;
        }, selectedEvent.eventName);

        const liveEventOptionEl = liveEventOptionHandle.asElement();
        if (liveEventOptionEl) {
            await liveEventOptionEl.click();
            await liveEventOptionHandle.dispose();
            console.log(`   ✓ Selected event`);

            // Wait for the live event modal to close (poll until span._5CBcT3-a7O is gone)
            for (let i = 0; i < 20; i++) {
                const modalGone = await page.evaluate(() => {
                    const spans = document.querySelectorAll('span._5CBcT3-a7O');
                    for (const s of spans) {
                        if (s.getBoundingClientRect().width > 0) return false;
                    }
                    return true;
                });
                if (modalGone) break;
                await sleep(300);
            }
            console.log(`   ✓ Live Event modal closed`);
        } else {
            await liveEventOptionHandle.dispose();
            console.log(`   ⚠ Could not select event from list`);
        }
        await sleep(500);
    } else {
        await liveEventFieldHandle.dispose();
        console.log('   ⚠ Could not find Live Event field');
    }

    // Scroll back to top so subsequent steps find the correct elements
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(500);

    // =============================================
    // STEP 2: Fill Title (Meetup Name)
    // =============================================
    console.log(`2. Filling Meetup Name...`);
    
    // Use Puppeteer's native methods for input
    const titleInput = await page.$('input[placeholder="Meetup Name"]');
    if (titleInput) {
        await titleInput.click({ clickCount: 3 }); // Select all
        await titleInput.type(selectedEvent.eventName);
        console.log(`   ✓ Title: "${selectedEvent.eventName}"`);
    } else {
        console.log('   ⚠ Title input not found');
    }
    
    // =============================================
    // STEP 3: Fill Description
    // =============================================
    console.log(`3. Filling Description...`);
    
    const description = `Join us for ${selectedEvent.eventName}!`;
    const descTextarea = await page.$('textarea');
    if (descTextarea) {
        await descTextarea.click();
        await descTextarea.type(description);
        console.log(`   ✓ Description filled`);
    } else {
        console.log('   ⚠ Description textarea not found');
    }
    
    // Helper to click outer-DOM "Done" span (used by both calendar and time picker)
    async function clickDoneButton() {
        // Wait for any picker scroll animation to fully settle
        await sleep(800);
        const doneEl = await page.evaluateHandle(() => {
            const spans = document.querySelectorAll('span');
            for (const span of spans) {
                if (span.textContent.trim() === 'Done' && span.getBoundingClientRect().width > 0) {
                    return span.parentElement;
                }
            }
            return null;
        });
        const el = doneEl.asElement();
        if (el) {
            await el.click();
        }
        await doneEl.dispose();
        await sleep(500);
    }

    // Helper: click a day in the calendar shadow DOM, navigate months if needed, then click Done
    async function pickCalendarDay(day, month, year) {
        // Navigate to correct month and click the day
        for (let attempt = 0; attempt < 6; attempt++) {
            const result = await page.evaluate((d, m, y) => {
                // Find the visible ion-datetime that has calendar day buttons
                let target = null;
                for (const el of document.querySelectorAll('ion-datetime')) {
                    if (!el.shadowRoot) continue;
                    if (el.getBoundingClientRect().width === 0) continue;
                    if (el.shadowRoot.querySelectorAll('button[data-day]').length > 0) { target = el; break; }
                }
                if (!target) return { done: false, nopicker: true };

                const btn = target.shadowRoot.querySelector(`button[data-day="${d}"][data-month="${m}"][data-year="${y}"]`);
                if (btn && !btn.disabled) {
                    btn.click();
                    return { done: true };
                }

                // Navigate to next month
                const navBtns = target.shadowRoot.querySelectorAll('.calendar-next-prev ion-button');
                if (navBtns.length >= 2) {
                    navBtns[1].click();
                    return { done: false, navigated: true };
                }
                return { done: false, navigated: false };
            }, day, month, year);

            if (result.nopicker || result.done) break;
            await sleep(500);
        }
        await sleep(300);

        // Close the calendar using the same real CDP click on Done
        await clickDoneButton();

        // Poll until calendar is fully closed
        for (let i = 0; i < 20; i++) {
            const closed = await page.evaluate(() => {
                for (const el of document.querySelectorAll('ion-datetime')) {
                    if (!el.shadowRoot) continue;
                    if (el.getBoundingClientRect().width > 0 && el.shadowRoot.querySelectorAll('button[data-day]').length > 0) return false;
                }
                return true;
            });
            if (closed) break;
            await sleep(200);
        }
        await sleep(300);
    }

    // Helper: pick time via ion-picker-column-internal shadow DOM buttons
    // Column 0 = hour (data-value is 24h), Column 1 = minute (steps of 5), Column 2 = AM/PM
    async function pickTime(hour, minute) {
        const ampm = hour >= 12 ? 'pm' : 'am';
        // data-value matches 24h directly: AM 0-11, PM 12-23
        const h24val = hour;
        const minuteRounded = Math.round(minute / 5) * 5;

        // Poll until we find an ion-datetime with 3 picker columns (the time picker, not the calendar)
        let ready = false;
        for (let i = 0; i < 20; i++) {
            ready = await page.evaluate(() => {
                const all = document.querySelectorAll('ion-datetime');
                for (const el of all) {
                    if (!el.shadowRoot) continue;
                    const cols = el.shadowRoot.querySelectorAll('ion-picker-column-internal');
                    if (cols.length >= 3) return true;
                }
                return false;
            });
            if (ready) break;
            await sleep(300);
        }

        const result = await page.evaluate((ap) => {
            let cols = null;
            const all = document.querySelectorAll('ion-datetime');
            for (const el of all) {
                if (!el.shadowRoot) continue;
                const c = el.shadowRoot.querySelectorAll('ion-picker-column-internal');
                if (c.length >= 3) { cols = c; break; }
            }
            if (!cols) return { found: false, colCount: 0 };

            // Step 1: Click AM/PM first so hour column re-renders with correct values
            const ampmBtn = cols[2].shadowRoot?.querySelector(`button[data-value="${ap}"]`);
            if (ampmBtn) ampmBtn.click();
            return { found: true, clicked: ['ampm:' + ap] };
        }, ampm);

        // Wait for AM/PM switch to re-render the hour column
        await sleep(500);

        // Step 2: Click hour (now correct column is showing)
        const hourClicked = await page.evaluate((h24val) => {
            const all = document.querySelectorAll('ion-datetime');
            for (const el of all) {
                if (!el.shadowRoot) continue;
                const cols = el.shadowRoot.querySelectorAll('ion-picker-column-internal');
                if (cols.length < 3) continue;
                const btn = cols[0].shadowRoot?.querySelector(`button[data-value="${h24val}"]`);
                if (btn) { btn.click(); return true; }
            }
            return false;
        }, h24val);
        if (hourClicked && result.found) result.clicked.push('hour:' + h24val);

        // Wait for hour wheel animation to settle before clicking minute
        await sleep(600);

        // Click minute in a separate evaluate so it runs after the hour animation.
        // For min=0: first click minute 5 to force movement, then click 0.
        if (result.found) {
            if (minuteRounded === 0) {
                // Force the wheel to move away from 0 first, then back
                await page.evaluate(() => {
                    const all = document.querySelectorAll('ion-datetime');
                    for (const el of all) {
                        if (!el.shadowRoot) continue;
                        const cols = el.shadowRoot.querySelectorAll('ion-picker-column-internal');
                        if (cols.length < 3) continue;
                        const btn5 = cols[1].shadowRoot?.querySelector('button[data-value="5"]');
                        if (btn5) { btn5.click(); return; }
                    }
                });
                await sleep(400);
            }

            // Click the target minute 3 times to make sure it sticks
            for (let attempt = 0; attempt < 3; attempt++) {
                if (attempt > 0) await sleep(300);
                await page.evaluate((min5) => {
                    const all = document.querySelectorAll('ion-datetime');
                    for (const el of all) {
                        if (!el.shadowRoot) continue;
                        const cols = el.shadowRoot.querySelectorAll('ion-picker-column-internal');
                        if (cols.length < 3) continue;
                        const minBtn = cols[1].shadowRoot?.querySelector(`button[data-value="${min5}"]`);
                        if (minBtn) { minBtn.click(); return true; }
                    }
                    return false;
                }, minuteRounded);
            }
            result.clicked.push('min:' + minuteRounded);
        }

        await sleep(1000); // wait for column scroll animations to fully settle

        // Click "Done" to close the time picker
        await clickDoneButton();

        // Poll until the time picker (3-col ion-datetime) is gone
        for (let i = 0; i < 20; i++) {
            const gone = await page.evaluate(() => {
                for (const el of document.querySelectorAll('ion-datetime')) {
                    if (!el.shadowRoot) continue;
                    if (el.getBoundingClientRect().width > 0 &&
                        el.shadowRoot.querySelectorAll('ion-picker-column-internal').length >= 3) return false;
                }
                return true;
            });
            if (gone) break;
            await sleep(200);
        }
        await sleep(300);

        return result;
    }

    const pad = n => String(n).padStart(2, '0');

    // =============================================
    // STEP 4: Start Date
    // =============================================
    console.log(`4. Setting Start Date: ${formatDate(startDT)}...`);

    await page.evaluate(() => {
        const spans = document.querySelectorAll('span');
        for (const span of spans) {
            if (/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat),/.test(span.textContent.trim())) {
                span.click(); break;
            }
        }
    });
    await sleep(800);
    await pickCalendarDay(startDT.day, startDT.month, startDT.year);
    console.log(`   ✓ Start Date set to ${startDT.day}/${startDT.month}/${startDT.year}`);

    // =============================================
    // STEP 5: Start Time
    // =============================================
    console.log(`5. Setting Start Time: ${formatTime(startDT)}...`);

    await page.evaluate(() => {
        const spans = document.querySelectorAll('span');
        for (const span of spans) {
            if (/^\d{1,2}:\d{2} (AM|PM)$/.test(span.textContent.trim())) {
                span.click(); break;
            }
        }
    });
    const startTimeRes = await pickTime(startDT.hour, startDT.minute);
    console.log(`   ✓ Start Time clicked: ${JSON.stringify(startTimeRes.clicked || startTimeRes)}`);

    // =============================================
    // STEP 6: End Date
    // =============================================
    console.log(`6. Setting End Date: ${formatDate(endDT)}...`);

    await page.evaluate(() => {
        const spans = document.querySelectorAll('span');
        const dateSpans = [];
        for (const span of spans) {
            if (/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat),/.test(span.textContent.trim())) dateSpans.push(span);
        }
        (dateSpans[1] || dateSpans[0])?.click();
    });
    await sleep(800);
    await pickCalendarDay(endDT.day, endDT.month, endDT.year);
    console.log(`   ✓ End Date set to ${endDT.day}/${endDT.month}/${endDT.year}`);

    // =============================================
    // STEP 6b: End Time
    // =============================================
    console.log(`6b. Setting End Time: ${formatTime(endDT)}...`);

    await page.evaluate(() => {
        const spans = document.querySelectorAll('span');
        const timeSpans = [];
        for (const span of spans) {
            if (/^\d{1,2}:\d{2} (AM|PM)$/.test(span.textContent.trim())) timeSpans.push(span);
        }
        (timeSpans[1] || timeSpans[0])?.click();
    });
    const endTimeRes = await pickTime(endDT.hour, endDT.minute);
    console.log(`   ✓ End Time clicked: ${JSON.stringify(endTimeRes.clicked || endTimeRes)}`);

    // Set the date on the ion-datetime hidden input and the component
    const startDateSet = await page.evaluate((dt) => {
        // Build ISO date string with timezone offset (+05:30 for IST)
        const pad = n => String(n).padStart(2, '0');
        const isoDate = `${dt.year}-${pad(dt.month)}-${pad(dt.day)}T${pad(dt.hour)}:${pad(dt.minute)}:00+05:30`;

        // Set on hidden input
        const hiddenInput = document.querySelector('input[name^="ion-dt"]');
        if (hiddenInput) {
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeInputValueSetter.call(hiddenInput, isoDate);
            hiddenInput.dispatchEvent(new Event('input', { bubbles: true }));
            hiddenInput.dispatchEvent(new Event('change', { bubbles: true }));
        }

        // Set on ion-datetime element
        const ionDatetime = document.querySelector('ion-datetime');
        if (ionDatetime) {
            ionDatetime.value = isoDate;
            ionDatetime.dispatchEvent(new CustomEvent('ionChange', { detail: { value: isoDate }, bubbles: true }));
            return { success: true, value: isoDate, foundHidden: !!hiddenInput };
        }
        return { success: false };
    }, startDT);

    // =============================================
    // STEP 7: Fill Location (Map Picker)
    // =============================================
    console.log(`7. Filling Location...`);

    // 7a. Open the location map picker
    const locationFieldHandle = await page.evaluateHandle(() => {
        const loc = document.querySelector('[data-test-id="GroupLocationLabelId"]');
        if (loc) {
            loc.scrollIntoView({ behavior: 'instant', block: 'center' });
            return loc.parentElement;
        }
        for (const span of document.querySelectorAll('span')) {
            if (span.textContent?.includes('Ferry Building')) {
                span.scrollIntoView({ behavior: 'instant', block: 'center' });
                return span.parentElement;
            }
        }
        return null;
    });
    const locationFieldEl = locationFieldHandle.asElement();
    if (locationFieldEl) {
        await locationFieldEl.click();
        await locationFieldHandle.dispose();
        console.log(`   ✓ Opened Location picker`);
        await sleep(3000);

        // 7b. Click three-dots (⋮) menu next to "No location selected"
        const threeDotsHandle = await page.evaluateHandle(() => {
            for (const el of document.querySelectorAll('*')) {
                if (el.children.length === 0 && el.textContent?.trim() === 'No location selected') {
                    const parent = el.parentElement;
                    if (!parent) continue;
                    const icon = parent.querySelector('ion-icon') || parent.parentElement?.querySelector('ion-icon');
                    if (icon) return icon;
                    for (const sibling of parent.children) {
                        if (sibling !== el && sibling.tagName !== 'SPAN') return sibling;
                    }
                    return parent;
                }
            }
            return null;
        });
        const threeDotsEl = threeDotsHandle.asElement();
        if (threeDotsEl) {
            await threeDotsEl.click();
            await threeDotsHandle.dispose();
            console.log(`   ✓ Clicked three-dots menu`);
            await sleep(1000);

            // 7c. Click "Search for a location" menu item
            const searchMenuHandle = await page.evaluateHandle(() => {
                for (const el of document.querySelectorAll('span, div, li')) {
                    if (el.textContent?.trim() === 'Search for a location') {
                        const r = el.getBoundingClientRect();
                        if (r.width > 0 && r.height > 0) return el;
                    }
                }
                return null;
            });
            const searchMenuEl = searchMenuHandle.asElement();
            if (searchMenuEl) {
                await searchMenuEl.click();
                await searchMenuHandle.dispose();
                console.log(`   ✓ Clicked "Search for a location"`);
                await sleep(1500);

                // 7d. Type search term
                const searchInputHandle = await page.evaluateHandle(() => {
                    for (const inp of document.querySelectorAll('input')) {
                        const r = inp.getBoundingClientRect();
                        if (r.width > 0 && r.height > 0 && inp.placeholder !== 'Meetup Name') return inp;
                    }
                    return null;
                });
                const searchInputEl = searchInputHandle.asElement();
                if (searchInputEl) {
                    await searchInputEl.click();
                    await searchInputEl.type(CONFIG.locationSearch, { delay: 60 });
                    await searchInputHandle.dispose();
                    console.log(`   ✓ Typed: ${CONFIG.locationSearch}`);
                    await sleep(2500);

                    // 7e. Click the desired result by index
                    const resultHandle = await page.evaluateHandle((idx, searchTerm) => {
                        const lower = searchTerm.toLowerCase();
                        const titleSpans = [...document.querySelectorAll('span')].filter(s => {
                            const r = s.getBoundingClientRect();
                            const t = s.textContent?.trim();
                            return r.width > 0 && r.height > 0 && r.height < 30 &&
                                t && t.toLowerCase().includes(lower);
                        });
                        if (titleSpans.length > idx) {
                            let el = titleSpans[idx];
                            for (let i = 0; i < 5; i++) {
                                if (!el.parentElement) break;
                                el = el.parentElement;
                                const r = el.getBoundingClientRect();
                                if (r.height > 40) return el;
                            }
                            return titleSpans[idx];
                        }
                        return null;
                    }, CONFIG.locationResultIndex, CONFIG.locationSearch);
                    const resultEl = resultHandle.asElement();
                    if (resultEl) {
                        await resultEl.click();
                        await resultHandle.dispose();
                        console.log(`   ✓ Selected result #${CONFIG.locationResultIndex + 1}`);
                    } else {
                        await resultHandle.dispose();
                        console.log(`   ⚠ Result #${CONFIG.locationResultIndex + 1} not found`);
                    }
                    await sleep(2000);
                } else {
                    await searchInputHandle.dispose();
                    console.log(`   ⚠ Search input not found`);
                }
            } else {
                await searchMenuHandle.dispose();
                console.log(`   ⚠ "Search for a location" menu item not found`);
            }
        } else {
            await threeDotsHandle.dispose();
            console.log(`   ⚠ Three-dots button not found`);
        }

        // 7f. Click Save
        await sleep(500);
        const saveHandle = await page.evaluateHandle(() => {
            for (const span of document.querySelectorAll('span')) {
                if (span.textContent?.trim() === 'Save') return span;
            }
            return null;
        });
        const saveEl = saveHandle.asElement();
        if (saveEl) {
            await saveEl.click();
            await saveHandle.dispose();
            console.log(`   ✓ Location saved`);
        } else {
            await saveHandle.dispose();
            console.log(`   ⚠ Save button not found`);
        }
        await sleep(1000);
    } else {
        await locationFieldHandle.dispose();
        console.log(`   ⚠ Location field not found`);
    }
    
    // =============================================
    // STEP 8: Select Group
    // =============================================
    await sleep(500); // ensure form is settled before opening group dropdown
    console.log(`8. Selecting Group: ${CONFIG.group}...`);

    const groupClicked = await page.evaluateHandle(() => {
        const spans = document.querySelectorAll('span');
        for (const span of spans) {
            if (span.textContent?.trim() === 'Select a Group') {
                return span.parentElement?.parentElement || span.parentElement;
            }
        }
        return null;
    });
    const groupFieldEl = groupClicked.asElement();
    if (groupFieldEl) {
        await groupFieldEl.click();
        await groupClicked.dispose();
        console.log(`   ✓ Opened Group dropdown`);
        await sleep(1000);

        // Find and click the group option by exact text
        const groupHandle = await page.evaluateHandle((groupName) => {
            const spans = document.querySelectorAll('span');
            for (const span of spans) {
                if (span.textContent.trim() === groupName) return span;
            }
            return null;
        }, CONFIG.group);

        const groupEl = groupHandle.asElement();
        if (groupEl) {
            await groupEl.click();
            console.log(`   ✓ Group selected`);
        } else {
            console.log(`   ⚠ Group "${CONFIG.group}" not found in options`);
        }
        await groupHandle.dispose();
        await sleep(500);
    } else {
        await groupClicked.dispose();
        console.log('   ⚠ Group field not found');
    }
    
    // =============================================
    // STEP 9: Check Community Ambassador (only visible after group is selected)
    // =============================================
    if (CONFIG.hostedByCommunityAmbassador) {
        console.log(`9. Checking "Hosted by Community Ambassador"...`);

        // Wait a bit more for the toggle to appear after group selection
        await sleep(1000);

        // Poll until the ambassador toggle appears (it renders after group selection)
        let ambassadorChecked = { success: false };
        for (let attempt = 0; attempt < 30; attempt++) {
            ambassadorChecked = await page.evaluate(() => {
                const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                while (walker.nextNode()) {
                    const text = walker.currentNode.textContent.toLowerCase();
                    if (text.includes('hosted by') && text.includes('ambassador')) {
                        const parent = walker.currentNode.parentElement;
                        // Walk up to find the toggle/checkbox
                        let el = parent;
                        for (let i = 0; i < 5; i++) {
                            if (!el) break;
                            const toggle = el.querySelector('input[type="checkbox"], ion-checkbox, ion-toggle, [role="checkbox"], [role="switch"]');
                            if (toggle) {
                                // Only click if not already checked
                                const isChecked = toggle.checked || toggle.getAttribute('aria-checked') === 'true';
                                if (!isChecked) toggle.click();
                                return { success: true, element: toggle.tagName, wasAlreadyChecked: isChecked };
                            }
                            el = el.parentElement;
                        }
                        // Fallback: click the label row itself
                        if (parent) {
                            parent.click();
                            return { success: true, element: 'label', wasAlreadyChecked: false };
                        }
                    }
                }
                return { success: false };
            });

            if (ambassadorChecked.success) break;
            await sleep(500);
        }

        if (ambassadorChecked.success) {
            if (ambassadorChecked.wasAlreadyChecked) {
                console.log(`   ✓ Ambassador checkbox already checked`);
            } else {
                console.log(`   ✓ Ambassador checkbox toggled`);
            }
        } else {
            console.log('   ⚠ Ambassador checkbox not found');
        }
    }
    
    console.log('\n📝 Form filled — proceeding to submission...\n');

    // =============================================
    // STEP 10: Click Continue (bottom of form)
    // =============================================
    console.log('10. Clicking Continue...');
    await page.evaluate(() => {
        document.querySelectorAll('*').forEach(el => {
            const s = window.getComputedStyle(el);
            if ((s.overflowY === 'scroll' || s.overflowY === 'auto') && el.scrollHeight > el.clientHeight)
                el.scrollTop = 99999;
        });
    });
    await sleep(500);
    const cont1Clicked = await page.evaluate(() => {
        for (const btn of document.querySelectorAll('ion-button')) {
            if (btn.textContent?.trim() === 'Continue') {
                const r = btn.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) { btn.click(); return true; }
            }
        }
        return false;
    });
    if (cont1Clicked) {
        console.log('   ✓ Continue clicked');
    } else {
        console.log('   ⚠ Continue button not found');
    }
    await sleep(1500);

    // =============================================
    // STEP 11: Select All Members + Continue
    // =============================================
    console.log('11. Selecting All Members...');
    const allMembersClicked = await page.evaluate(() => {
        for (const span of document.querySelectorAll('span')) {
            if (span.textContent?.trim() === 'All Members') {
                const r = span.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) {
                    let el = span;
                    for (let i = 0; i < 5; i++) {
                        if (!el.parentElement) break;
                        el = el.parentElement;
                        if (el.tagName === 'ION-ITEM') { el.click(); return true; }
                    }
                    span.click();
                    return true;
                }
            }
        }
        return false;
    });
    if (allMembersClicked) {
        console.log('   ✓ All Members selected');
    } else {
        console.log('   ⚠ All Members not found');
    }
    await sleep(800);

    const cont2Clicked = await page.evaluate(() => {
        for (const btn of document.querySelectorAll('ion-button')) {
            if (btn.textContent?.trim() === 'Continue') {
                const r = btn.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) { btn.click(); return true; }
            }
        }
        return false;
    });
    if (cont2Clicked) {
        console.log('   ✓ Continue (Invites) clicked');
    } else {
        console.log('   ⚠ Continue (Invites) not found');
    }
    await sleep(1500);

    // =============================================
    // STEP 12: Scroll Confirm modal + click Create Meetup
    // =============================================
    console.log('12. Creating Meetup...');
    await page.evaluate(() => {
        document.querySelectorAll('*').forEach(el => {
            const s = window.getComputedStyle(el);
            if ((s.overflowY === 'scroll' || s.overflowY === 'auto') && el.scrollHeight > el.clientHeight)
                el.scrollTop = 99999;
        });
    });
    await sleep(800);
    const createClicked = await page.evaluate(() => {
        for (const btn of document.querySelectorAll('ion-button')) {
            if (btn.textContent?.trim() === 'Create Meetup') {
                const r = btn.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) { btn.click(); return true; }
            }
        }
        return false;
    });
    if (createClicked) {
        console.log('   ✓ Create Meetup clicked!');
    } else {
        console.log('   ⚠ Create Meetup button not found');
    }
    await sleep(2000);

    const meetupElapsedMs = Date.now() - meetupStartTime;
    const elapsedSec = (meetupElapsedMs / 1000).toFixed(1);

    console.log('\n' + '═'.repeat(50));
    console.log(`Event: ${eventNum} - ${selectedEvent.eventName} ✅ Meetup created successfully!`);
    console.log(`⏱  Time taken: ${elapsedSec}s`);
    console.log('═'.repeat(50) + '\n');
    } // end while

    rl.close();
    await browser.disconnect();
}

main().catch(err => {
    console.error('Error:', err.message);
    rl.close();
});
