---
name: browser-file-upload
description: Master guide for uploading any file (video, image, document, audio) from PC to any website (YouTube, TikTok, WhatsApp, Google Drive, Instagram, etc.) using browser automation. Fixes the OS file picker problem. Load this skill whenever the user asks to upload a file to a website.
user-invocable: false
tags: [browser, upload, file, youtube, tiktok, whatsapp, automation]
---

# Browser File Upload — Master Skill

## WHY CLICKING THE UPLOAD BUTTON FAILS

When a human clicks an upload button on a website, the **Operating System opens a native file picker window** (Windows Explorer / Finder). This is a separate OS-level window — it is NOT part of the browser page. AI browser tools cannot see or control this OS window.

```
❌ WRONG APPROACH (what humans do):
  browser_click("Upload button")
  → OS file picker opens
  → AI is stuck — cannot see the OS window
  → Upload never happens

✅ CORRECT APPROACH (AI method):
  Use browser_upload_file() to inject the file directly
  → Bypasses OS file picker completely
  → File goes straight into the browser's file input
```

---

## PRE-FLIGHT CHECKLIST (Do This Before Every Upload)

### Step 1 — Confirm the exact file path
Before navigating to any website, always confirm the file path first:

```
Use os_exec to verify the file exists:
  os_exec("dir C:\Users\Username\Videos\myfile.mp4")

If path is unknown, search for it:
  os_exec('Get-ChildItem -Path C:\Users -Recurse -Filter "*.mp4" | Select-Object FullName')
```

**Save the exact absolute path in your working memory** — you will need it later.
Example: `C:\Users\Akshay\Videos\myvideo.mp4`

### Step 2 — Check file size
```
os_exec('(Get-Item "C:\Users\Akshay\Videos\myvideo.mp4").length / 1MB')
```
Large files (>500MB) may have upload timeouts. Note this.

### Step 3 — Navigate to the website
```
browser_navigate("https://youtube.com")
```
Wait for the page to fully load.

---

## THE TWO UPLOAD METHODS

### METHOD 1 — Direct Input Targeting (Try This First)

Many websites have a hidden `input[type=file]` element. Find it and inject the file directly without clicking anything.

```
Step 1: Take a snapshot to check for file inputs
  browser_snapshot()

Step 2: Search for file input elements using query_selector
  browser_query_selector("input[type=file]")
  browser_query_selector("input[type=file][accept*='video']")
  browser_query_selector("input[type=file][accept*='image']")

Step 3: If found, upload directly using the ref number or CSS selector
  browser_upload_file(
    selector: "input[type=file]",   ← CSS selector
    filePath: "C:\Users\Akshay\Videos\myvideo.mp4"
  )

  OR with ref number from snapshot:
  browser_upload_file(
    selector: "15",                  ← ref number from snapshot
    filePath: "C:\Users\Akshay\Videos\myvideo.mp4"
  )
```

After calling browser_upload_file with a selector, the file is injected. Then take a browser_screenshot to verify the upload started.

---

### METHOD 2 — File Chooser Intercept (For Hidden Inputs / YouTube / TikTok)

Most modern platforms (YouTube, TikTok, Instagram, WhatsApp) have a completely hidden file input — it only becomes active when you click the upload button. For these:

```
CRITICAL SEQUENCE — Order matters exactly:

Step 1: Find the upload button via snapshot
  browser_snapshot()
  → Look for: "Upload", "Select file", "Choose file", "Add video", "+ icon"

Step 2: Call browser_upload_file WITHOUT selector IMMEDIATELY after clicking
  Use Promise-like thinking: click triggers the file chooser,
  browser_upload_file intercepts it

  browser_click(selector: "upload button ref")
  ← click happens → file chooser opens in background

  browser_upload_file(
    filePath: "C:\Users\Akshay\Videos\myvideo.mp4"
    ← NO selector here — intercepts the open file chooser
  )

Step 3: Verify with screenshot
  browser_screenshot()
```

**Important:** The click and browser_upload_file must happen in quick succession. Do not take snapshots or do other actions between them.

---

## PLATFORM-SPECIFIC GUIDES

### YouTube Upload

```
1. browser_navigate("https://studio.youtube.com")
2. browser_snapshot()
   → Look for: "CREATE" button or camera+ icon
3. browser_click(selector: "CREATE button ref")
4. browser_snapshot()
   → Look for: "Upload videos" option
5. browser_click(selector: "Upload videos ref")
6. browser_upload_file(filePath: "C:\path\to\video.mp4")
   ← NO selector needed — intercepts file chooser
7. browser_screenshot()
   → Verify upload progress bar appears
8. browser_wait(text: "Upload complete", timeout: 300000)
   → Wait up to 5 minutes for upload
9. Fill in title, description, then publish
```

### TikTok Upload

```
1. browser_navigate("https://www.tiktok.com/upload")
2. browser_wait(loadState: "networkidle")
3. browser_snapshot()
   → Look for drag-and-drop zone or "Select video" button
4. Try Method 1 first:
   browser_query_selector("input[type=file]")
   browser_upload_file(selector: "input[type=file]", filePath: "C:\path\to\video.mp4")
5. If Method 1 fails, try Method 2:
   browser_click(selector: "Select video button ref")
   browser_upload_file(filePath: "C:\path\to\video.mp4")
6. browser_screenshot()
   → Verify video preview appears
```

### WhatsApp Web — Send File

```
1. browser_navigate("https://web.whatsapp.com")
2. browser_wait(text: "Chats", timeout: 30000)
   → Wait for WhatsApp to load (may need QR scan first time)
3. browser_click(selector: "Contact/Group name ref")
4. browser_snapshot()
   → Look for attachment icon (paperclip icon)
5. browser_click(selector: "Attachment/paperclip icon ref")
6. browser_snapshot()
   → Look for "Photos & Videos" or "Documents" option
7. browser_click(selector: "Photos & Videos ref")
8. browser_upload_file(filePath: "C:\path\to\file.mp4")
   ← Intercepts file chooser
9. browser_screenshot()
   → Verify file preview appears in chat box
10. browser_click(selector: "Send button ref")
```

### Google Drive Upload

```
1. browser_navigate("https://drive.google.com")
2. browser_snapshot()
   → Look for "+ New" button
3. browser_click(selector: "+ New ref")
4. browser_snapshot()
   → Look for "File upload" option
5. browser_click(selector: "File upload ref")
6. browser_upload_file(filePath: "C:\path\to\file.pdf")
7. browser_wait(text: "Upload complete", timeout: 120000)
```

### Instagram (via browser)

```
1. browser_navigate("https://www.instagram.com")
2. browser_snapshot()
   → Look for + Create button in sidebar
3. browser_click(selector: "Create/+ ref")
4. browser_upload_file(filePath: "C:\path\to\image.jpg")
   ← Intercepts file chooser immediately
5. browser_screenshot()
   → Verify image preview appears
```

---

## MULTIPLE FILES UPLOAD

```
browser_upload_file(
  selector: "input[type=file]",
  filePaths: [
    "C:\Users\Akshay\Photos\photo1.jpg",
    "C:\Users\Akshay\Photos\photo2.jpg",
    "C:\Users\Akshay\Photos\photo3.jpg"
  ]
)
```

Note: Only works if the website's file input has `multiple` attribute.

---

## TROUBLESHOOTING

### Problem: "Element not found" for file input
```
Solution 1: Use JavaScript to find hidden inputs
  browser_execute_script("() => { const el = document.querySelector('input[type=file]'); if(el) return {found: true, accept: el.accept, multiple: el.multiple}; return {found: false}; }")

Solution 2: Make hidden input visible then target it
  browser_execute_script("() => { const el = document.querySelector('input[type=file]'); if(el) { el.style.display = 'block'; el.style.visibility = 'visible'; el.style.opacity = '1'; } }")
  → Then retry browser_upload_file with selector: "input[type=file]"
```

### Problem: File chooser timeout — "no file chooser appeared"
```
Cause: You called browser_upload_file BEFORE clicking the upload button,
       or too much time passed between click and upload call.

Solution:
  1. Take a fresh browser_snapshot()
  2. Identify the exact upload trigger button
  3. Click it: browser_click(selector: "upload trigger ref")
  4. Immediately call: browser_upload_file(filePath: "C:\path\to\file")
  (Do NOT take snapshots between step 3 and 4)
```

### Problem: Upload starts but fails mid-way
```
Cause: File too large, slow connection, or session timeout

Solution:
  1. Check file size with os_exec
  2. browser_wait(text: "upload", timeout: 600000) → wait longer (10 min)
  3. If still failing: browser_get_console() → check for errors
     browser_get_errors() → check JavaScript errors
```

### Problem: Page requires login before upload
```
Solution: Handle login first
  1. browser_snapshot() → find login/sign-in button
  2. browser_click(login button)
  3. browser_type(email field, "user@email.com")
  4. browser_type(password field, "password")
  5. browser_press_key("Enter")
  6. browser_wait(loadState: "networkidle")
  7. Now proceed with upload
```

### Problem: React/Vue site — file selected but upload doesn't start
```
Cause: Framework needs input/change events to detect file selection.
       browser_upload_file already dispatches these events automatically.

If still failing:
  browser_execute_script("() => { const el = document.querySelector('input[type=file]'); if(el) { el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); } }")
```

---

## ⚠️ CRITICAL RULES — BREAKING THESE CAUSES THE FAILURE LOOP

### RULE 1 — ALWAYS include file extension in the path

```
❌ WRONG: "C:\Users\Akshay\Downloads\final thumbnail"
✅ RIGHT:  "C:\Users\Akshay\Downloads\final thumbnail.png"
```

The system will TRY to auto-resolve missing extensions, but you must ALWAYS
use the exact filename including extension to avoid the failure loop.

HOW TO GET EXACT FILENAME:
  fs_read("C:\Users\Akshay\Downloads")
  → Read the exact filename as returned, including extension (.png, .mp4, etc.)
  → Copy the FULL filename exactly as shown, with extension

### RULE 2 — NEVER wait between browser_click and browser_upload_file

```
❌ WRONG SEQUENCE (causes loop):
  browser_click("upload button")
  browser_wait(...)              ← DO NOT WAIT HERE
  browser_upload_file(...)       ← file chooser already timed out

✅ RIGHT SEQUENCE:
  browser_click("upload button")
  browser_upload_file(filePath: "...")   ← immediately, next action
```

### RULE 3 — NEVER re-check file location after upload failure

If browser_upload_file fails, do NOT go back and re-check the folder.
The file IS there. The problem is the path format (missing extension or wrong method).
Check the error message — it tells you exactly what path was tried.

### RULE 4 — State the full path explicitly before every upload

Before calling browser_upload_file, say it out loud in your reasoning:
"File path with extension: C:\Users\Akshay\Downloads\final thumbnail.png"
This prevents extension being dropped from memory.

### RULE 5 — Use absolute paths only
   - ✅ `C:\Users\Akshay\Videos\video.mp4`
   - ❌ `.\video.mp4` or `~/Videos/video.mp4` or relative paths

---

## QUICK DECISION TREE

```
Need to upload a file?
  ↓
Step 1: Confirm file path exists (os_exec)
  ↓
Step 2: Navigate to website
  ↓
Step 3: browser_query_selector("input[type=file]")
  ↓
  File input FOUND?
    YES → browser_upload_file(selector: "input[type=file]", filePath: "...")
    NO  → Find upload button via snapshot
           → browser_click(upload button)
           → browser_upload_file(filePath: "...") ← no selector
  ↓
Step 4: browser_screenshot() to verify
  ↓
Step 5: Complete the form (title, description, etc.) and submit
```
