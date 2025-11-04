Quick Spy: Advanced Locator Generation & Management Tool

A professional-grade Chrome extension for Test Automation Engineers, QA, and Developers to find, verify, and manage stable web locators.

This tool was built to solve the #1 problem in UI automation: brittle and unstable locators. It replaces the default "Copy XPath" in browser DevTools with a powerful, intelligent, and interactive spy tool designed for modern, complex web applications.

Key Features

Smart Locator Generation: Automatically generates multiple locator strategies (CSS, XPath, ID) for any element, prioritizing stability.

Intelligent Prioritization: Finds locators in the order professionals prefer:

Custom data-* attributes (data-testid, data-cy, etc.)

Stable IDs (ignoring dynamic ones)

Simple, human-readable Text

Robust Parent/Sibling relative paths

Interactive Side Panel: Don't just spy one element at a time. "Quick Spy" saves every element you capture to a persistent list in the side panel.

Live Search: Instantly filter your list of captured locators with a real-time search bar.

Bi-Directional Verification:

Page-to-Panel: Hover on the webpage in "Spy Mode" to see what you're targeting.

Panel-to-Page: Hover over a locator in the side panel, and it's instantly highlighted on the page with a blue box and arrow.

Active Verification & Highlight: Click the "Verify" button to get a live count of matching elements and highlight all of them on the page with an animated green box.

Clean JSON Export: Save your entire list of locators as a clean, simple JSON file, ready to be used in your automation framework or page-object model.

Customizable: Use the Options page to define your own project's data- attributes (e.g., data-qa, data-automation-id).

Modern Dark UI: A sleek, dark-mode interface that's easy on the eyes.

Feature Showcase

(Recommendation: Record short GIFs of these features and embed them here!)

Feature

Description

Manual Spy & Capture

[YOUR-GIF-HERE] 



 Enable Manual Spy, click on elements, and watch them instantly appear in the side panel with all generated locators.

Panel-to-Page Verification

[YOUR-GIF-HERE] 



 Hovering over items in the side panel instantly highlights the corresponding element on the page with a blue box and arrow.

Live Count & Verification

[YOUR-GIF-HERE] 



 Clicking "Verify" shows a live count and flashes all matching elements on the page with an animated green highlight.

Real-Time Search

[YOUR-GIF-HERE] 



 The side panel list filters in real-time as you type, making it easy to find any locator you've saved.

Installation

This extension is not yet on the Chrome Web Store and must be loaded as an unpacked extension in Developer Mode.

Download: Download this project (or clone the repository) to a folder on your computer.

Open Chrome: Go to chrome://extensions.

Enable Developer Mode: Toggle the "Developer mode" switch in the top-right corner.

Load the Extension:

Click the "Load unpacked" button.

Select the entire folder where you saved the project files.

Done! The "Quick Spy" (or "LocatorHub") icon will appear in your extensions toolbar.

How to Use

1. Manual Spy (The Main Workflow)

Open the extension popup from your Chrome toolbar.

Click "Enable Manual Spy". The button will turn gray, and you are now in Spy Mode.

As you hover over the webpage, elements will be highlighted with a red box.

Click any element to capture it.

You will see a "Saved!" toast, and the element (with all its locators) will appear in the side panel.

Click "Disable Manual Spy" in the popup when you are finished.

2. The Side Panel

Open It: The side panel will open automatically when you spy your first element. You can also open it from the Chrome side panel menu.

Search: Use the search bar at the top to filter your list by name.

Verify (Hover): Hover your mouse over any locator card to highlight it on the page (blue box).

Verify (Click): Click the "Verify" button to get a live count and see all matching elements (green box).

Copy: Click "Copy" to copy the formatted code snippet for any locator.

Save: Click "Save" to export all locators in the list to a clean locators-[timestamp].json file.

Clear: Click "Clear" to remove all saved locators and start fresh.

3. Options

Open the extension popup and click the "Options" link.

Enter your project's custom data attributes (e.g., data-qa, data-cy, data-test-id).

Click "Save." The locator generation logic will now prioritize these attributes.

Built With

JavaScript (ES6+)

HTML5

CSS3

Chrome Extension API (Manifest V3)

storage API for persistence.

sidePanel API for the main UI.

activeTab permission for page interaction.

downloads API for JSON export.

Cross-origin message passing between content scripts, background service workers, and UI panels.
