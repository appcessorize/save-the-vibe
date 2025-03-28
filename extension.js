const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const simpleGit = require("simple-git");

// WebView Panel reference
let saveMenuPanel = undefined;

function activate(context) {
  console.log("Git SaveGame extension is now active");

  // Create status bar item
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBarItem.text = "$(game-controller) SaveGame";
  statusBarItem.tooltip = "Open PlayStation SaveGame Menu";
  statusBarItem.command = "git-savegame-js.openSaveMenu";
  statusBarItem.show();

  // Register commands
  let openSaveMenuDisposable = vscode.commands.registerCommand(
    "git-savegame-js.openSaveMenu",
    () => {
      openSaveMenu(context);
    }
  );

  let quickSaveDisposable = vscode.commands.registerCommand(
    "git-savegame-js.quickSave",
    () => {
      quickSave();
    }
  );

  // Register auto-save on file save
  const autoSaveDisposable = vscode.workspace.onDidSaveTextDocument(
    (document) => {
      const config = vscode.workspace.getConfiguration("git-savegame-js");
      if (config.get("autoSaveEnabled", true)) {
        createAutoSave(document.fileName);
      }
    }
  );

  // Add disposables to context
  context.subscriptions.push(
    statusBarItem,
    openSaveMenuDisposable,
    quickSaveDisposable,
    autoSaveDisposable
  );

  // Initialize git repository if needed
  initializeGitRepo();
}

// Get the git repository
function getGit() {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    vscode.window.showErrorMessage("No workspace folder open");
    return null;
  }

  const rootPath = workspaceFolders[0].uri.fsPath;
  return simpleGit(rootPath);
}

// Initialize git repository if it doesn't exist
async function initializeGitRepo() {
  const git = getGit();
  if (!git) return;

  try {
    const isRepo = await git.checkIsRepo();
    if (!isRepo) {
      await git.init();
      vscode.window.showInformationMessage(
        "SaveGame initialized a new Git repository"
      );
    }
  } catch (err) {
    vscode.window.showErrorMessage(`Error initializing Git: ${err}`);
  }
}

// Create auto-save
async function createAutoSave(fileName) {
  const git = getGit();
  if (!git) return;

  try {
    const relativePath = path.basename(fileName);
    await git.add(fileName);
    await git.commit(`Auto-save: ${relativePath}`);
    vscode.window.setStatusBarMessage("Auto-saved!", 3000);
  } catch (err) {
    console.error("Failed to auto-save:", err);
  }
}

// Create quick save
async function quickSave() {
  const git = getGit();
  if (!git) return;

  try {
    await git.add(".");
    await git.commit(`Quick Save: ${new Date().toLocaleString()}`);
    vscode.window.showInformationMessage("Quick Save created!");
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to create Quick Save: ${err}`);
  }
}

// Open save menu webview
async function openSaveMenu(context) {
  const git = getGit();
  if (!git) return;

  // Check if panel already exists
  if (saveMenuPanel) {
    saveMenuPanel.reveal();
    return;
  }

  // Create webview panel
  saveMenuPanel = vscode.window.createWebviewPanel(
    "saveGameMenu",
    "PlayStation SaveGame",
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(context.extensionPath, "media")),
      ],
    }
  );

  // Handle panel disposal
  saveMenuPanel.onDidDispose(() => {
    saveMenuPanel = undefined;
  });

  // Get save slots
  const saveSlots = await getSaveSlots(git);

  // Set webview HTML content
  saveMenuPanel.webview.html = getPSOneHtml(saveSlots);

  // Handle webview messages
  saveMenuPanel.webview.onDidReceiveMessage(async (message) => {
    switch (message.command) {
      case "createSave":
        await createSave(git, message.name);
        refreshSaveMenu(git);
        break;
      case "loadSave":
        await loadSave(git, message.hash);
        break;
      case "deleteSave":
        vscode.window
          .showWarningMessage(
            `Are you sure you want to delete "${message.name}"?`,
            "Yes",
            "No"
          )
          .then(async (answer) => {
            if (answer === "Yes") {
              // In a real extension, you'd implement proper delete
              vscode.window.showInformationMessage(
                "Delete functionality would go here."
              );
              refreshSaveMenu(git);
            }
          });
        break;
    }
  });
}

// Get save slots from git history
async function getSaveSlots(git) {
  try {
    const config = vscode.workspace.getConfiguration("git-savegame-js");
    const maxSlots = config.get("maxSaveSlots", 6);

    // Get git log
    const log = await git.log({ maxCount: maxSlots });

    // Format commits as save slots
    const saveSlots = log.all.map((commit, index) => {
      const date = new Date(commit.date);
      const formattedDate = `${
        date.getMonth() + 1
      }/${date.getDate()}/${date.getFullYear()} - ${date.getHours()}:${String(
        date.getMinutes()
      ).padStart(2, "0")}`;

      return {
        id: index + 1,
        name: commit.message,
        date: formattedDate,
        hash: commit.hash,
        isEmpty: false,
      };
    });

    // Fill remaining slots
    const emptySlots = Array(Math.max(0, maxSlots - saveSlots.length))
      .fill(null)
      .map((_, index) => ({
        id: saveSlots.length + index + 1,
        name: "Empty",
        date: "",
        hash: "",
        isEmpty: true,
      }));

    return [...saveSlots, ...emptySlots];
  } catch (err) {
    console.error("Failed to get save slots:", err);
    return [];
  }
}

// Create a named save
async function createSave(git, name) {
  try {
    await git.add(".");
    await git.commit(`Save: ${name}`);
    vscode.window.showInformationMessage(`Save "${name}" created!`);
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to create save: ${err}`);
  }
}

// Load a save
async function loadSave(git, hash) {
  if (!hash) return;

  try {
    // Check for unsaved changes
    const status = await git.status();

    if (!status.isClean()) {
      const answer = await vscode.window.showWarningMessage(
        "You have unsaved changes. Create a save point first?",
        "Yes",
        "No",
        "Cancel"
      );

      if (answer === "Cancel") {
        return;
      }

      if (answer === "Yes") {
        const saveName = await vscode.window.showInputBox({
          prompt: "Enter a name for this save point",
        });

        if (saveName) {
          await createSave(git, saveName);
        } else {
          return;
        }
      }
    }

    // Reset to the selected commit
    await git.raw(["reset", "--hard", hash]);
    vscode.window.showInformationMessage("Save loaded successfully!");
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to load save: ${err}`);
  }
}

// Refresh save menu
async function refreshSaveMenu(git) {
  if (!saveMenuPanel) return;

  const saveSlots = await getSaveSlots(git);
  saveMenuPanel.webview.postMessage({
    command: "updateSaveSlots",
    saveSlots,
  });
}

// Helper function to render a single save slot
function renderSaveSlot(slot, index, isSelected) {
  return `
        <div class="save-slot ${
          isSelected ? "selected" : ""
        }" data-index="${index}">
            <div class="slot-number">${slot.id}</div>
            <div class="slot-info">
                <div class="slot-name">${slot.name}</div>
                <div class="slot-date">${slot.date}</div>
            </div>
        </div>
    `;
}

// Helper function to render preview
function renderPreview(slot) {
  if (slot.isEmpty) {
    return `
            <div class="preview-placeholder">
                <div>Empty Save Slot</div>
                <div>Press CREATE to make a new save</div>
            </div>
        `;
  } else {
    return `
            <div class="preview-content">
                <div class="preview-image">
                    Code Preview (PS1-style screenshot)
                </div>
                <div class="preview-name">${slot.name}</div>
                <div class="preview-date">${slot.date}</div>
            </div>
        `;
  }
}

// Generate PlayStation-style HTML
function getPSOneHtml(saveSlots) {
  // Generate the save slots HTML
  let slotsHtml = "";
  saveSlots.forEach((slot, index) => {
    slotsHtml += renderSaveSlot(slot, index, index === 0);
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>PlayStation SaveGame</title>
    <style>
        body {
            font-family: monospace;
            background-color: #0f0f2d;
            color: #ffffff;
            margin: 0;
            padding: 16px;
            overflow: hidden;
        }
        
        .header {
            font-size: 24px;
            margin-bottom: 20px;
            text-shadow: 2px 2px 4px rgba(0, 0, 255, 0.5);
            color: #aaaaff;
        }
        
        .container {
            display: flex;
            gap: 16px;
            height: calc(100vh - 120px);
        }
        
        .slots-container {
            flex: 1;
            border: 2px solid #5555bb;
            background-color: rgba(0, 0, 50, 0.7);
            padding: 12px;
            overflow-y: auto;
        }
        
        .preview-container {
            flex: 1;
            border: 2px solid #5555bb;
            background-color: rgba(0, 0, 50, 0.7);
            padding: 12px;
            display: flex;
            flex-direction: column;
        }
        
        .section-title {
            font-size: 18px;
            margin-bottom: 16px;
            color: #aaaaff;
        }
        
        .save-slot {
            display: flex;
            align-items: center;
            padding: 8px;
            margin-bottom: 8px;
            cursor: pointer;
            border-radius: 4px;
        }
        
        .save-slot:hover {
            background-color: rgba(100, 100, 255, 0.2);
        }
        
        .save-slot.selected {
            background-color: rgba(100, 100, 255, 0.5);
        }
        
        .slot-number {
            width: 30px;
            height: 30px;
            background-color: #5555bb;
            display: flex;
            align-items: center;
            justify-content: center;
            margin-right: 12px;
            font-weight: bold;
            border-radius: 4px;
        }
        
        .slot-info {
            flex: 1;
        }
        
        .slot-name {
            font-weight: bold;
            margin-bottom: 4px;
        }
        
        .slot-date {
            font-size: 12px;
            color: #aaaaaa;
        }
        
        .preview-placeholder {
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            color: #888888;
        }
        
        .preview-content {
            flex: 1;
            display: flex;
            flex-direction: column;
        }
        
        .preview-image {
            height: 200px;
            background-color: #555555;
            margin-bottom: 16px;
            border: 1px solid #5555bb;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #888888;
        }
        
        .preview-name {
            font-size: 18px;
            font-weight: bold;
            margin-bottom: 8px;
        }
        
        .preview-date {
            font-size: 14px;
            margin-bottom: 16px;
            color: #aaaaaa;
        }
        
        .buttons {
            display: flex;
            justify-content: space-between;
            margin-top: 16px;
        }
        
        button {
            padding: 8px 16px;
            background-color: #5555bb;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-family: monospace;
            display: flex;
            align-items: center;
        }
        
        button:hover {
            background-color: #7777dd;
        }
        
        button:disabled {
            background-color: #444466;
            cursor: not-allowed;
        }
        
        .button-icon {
            margin-right: 8px;
            font-weight: bold;
        }
        
        button.create {
            background-color: #5555bb;
        }
        
        button.load {
            background-color: #55bb55;
        }
        
        .modal {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: rgba(0, 0, 40, 0.8);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1000;
        }
        
        .modal-content {
            width: 400px;
            background-color: #0f0f2d;
            border: 2px solid #5555bb;
            padding: 16px;
        }
        
        .modal-title {
            font-size: 18px;
            margin-bottom: 16px;
            color: #aaaaff;
        }
        
        input {
            width: 100%;
            padding: 8px;
            background-color: #222244;
            border: 1px solid #5555bb;
            color: white;
            font-family: monospace;
            margin-bottom: 16px;
        }
        
        .modal-buttons {
            display: flex;
            justify-content: space-between;
        }
    </style>
</head>
<body>
    <div class="header">MEMORY CARD (VSCode)</div>
    
    <div class="container">
        <div class="slots-container">
            <div class="section-title">SAVE FILES</div>
            <div id="slots-list">
                ${slotsHtml}
            </div>
        </div>
        
        <div class="preview-container">
            <div class="section-title">SAVE DETAILS</div>
            <div id="preview-area">
                ${renderPreview(saveSlots[0])}
            </div>
        </div>
    </div>
    
    <div class="buttons">
        <div>
            <button class="create" id="create-button">
                <span class="button-icon">○</span> CREATE
            </button>
        </div>
        
        <button class="load" id="load-button" ${
          saveSlots[0].isEmpty ? "disabled" : ""
        }>
            <span class="button-icon">×</span> LOAD
        </button>
    </div>
    
    <div id="save-modal" class="modal" style="display: none;">
        <div class="modal-content">
            <div class="modal-title">CREATE NEW SAVE</div>
            <input type="text" id="save-name-input" placeholder="Enter save name..." />
            <div class="modal-buttons">
                <button id="cancel-save">Cancel</button>
                <button id="confirm-save" class="load">Save</button>
            </div>
        </div>
    </div>
    
    <script>
        (function() {
            const vscode = acquireVsCodeApi();
            let saveSlots = ${JSON.stringify(saveSlots)};
            let selectedIndex = 0;
            
            // Update the buttons based on selected slot
            function updateButtons() {
                const loadButton = document.getElementById('load-button');
                loadButton.disabled = saveSlots[selectedIndex].isEmpty;
            }
            
            // Render a single save slot
            function renderSaveSlot(slot, index, isSelected) {
                return \`
                    <div class="save-slot \${isSelected ? 'selected' : ''}" data-index="\${index}">
                        <div class="slot-number">\${slot.id}</div>
                        <div class="slot-info">
                            <div class="slot-name">\${slot.name}</div>
                            <div class="slot-date">\${slot.date}</div>
                        </div>
                    </div>
                \`;
            }
            
            // Render preview content
            function renderPreview(slot) {
                if (slot.isEmpty) {
                    return \`
                        <div class="preview-placeholder">
                            <div>Empty Save Slot</div>
                            <div>Press CREATE to make a new save</div>
                        </div>
                    \`;
                } else {
                    return \`
                        <div class="preview-content">
                            <div class="preview-image">
                                Code Preview (PS1-style screenshot)
                            </div>
                            <div class="preview-name">\${slot.name}</div>
                            <div class="preview-date">\${slot.date}</div>
                        </div>
                    \`;
                }
            }
            
            // Select a save slot
            function selectSlot(index) {
                // Update selected class
                document.querySelectorAll('.save-slot').forEach((el, i) => {
                    if (i === index) {
                        el.classList.add('selected');
                    } else {
                        el.classList.remove('selected');
                    }
                });
                
                // Update preview
                document.getElementById('preview-area').innerHTML = renderPreview(saveSlots[index]);
                
                // Update selected index
                selectedIndex = index;
                
                // Update buttons
                updateButtons();
            }
            
            function setupEventListeners() {
                // Add event listeners to slots
                document.querySelectorAll('.save-slot').forEach(slot => {
                    slot.addEventListener('click', (e) => {
                        const index = parseInt(slot.dataset.index);
                        selectSlot(index);
                    });
                });
                
                // Create save button
                document.getElementById('create-button').addEventListener('click', () => {
                    document.getElementById('save-modal').style.display = 'flex';
                    document.getElementById('save-name-input').focus();
                });
                
                // Load save button
                document.getElementById('load-button').addEventListener('click', () => {
                    const slot = saveSlots[selectedIndex];
                    if (!slot.isEmpty) {
                        vscode.postMessage({
                            command: 'loadSave',
                            hash: slot.hash,
                            name: slot.name
                        });
                    }
                });
                
                // Cancel save button
                document.getElementById('cancel-save').addEventListener('click', () => {
                    document.getElementById('save-modal').style.display = 'none';
                });
                
                // Confirm save button
                document.getElementById('confirm-save').addEventListener('click', () => {
                    const saveName = document.getElementById('save-name-input').value.trim();
                    if (saveName) {
                        vscode.postMessage({
                            command: 'createSave',
                            name: saveName
                        });
                        document.getElementById('save-modal').style.display = 'none';
                        document.getElementById('save-name-input').value = '';
                    }
                });
                
                // Handle save name input keypress
                document.getElementById('save-name-input').addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') {
                        document.getElementById('confirm-save').click();
                    }
                });
            }
            
            // Set up initial event listeners
            setupEventListeners();
            
            // Handle messages from extension
            window.addEventListener('message', event => {
                const message = event.data;
                
                if (message.command === 'updateSaveSlots') {
                    saveSlots = message.saveSlots;
                    
                    // Update slots list
                    let slotsHtml = '';
                    saveSlots.forEach((slot, index) => {
                        slotsHtml += renderSaveSlot(slot, index, index === selectedIndex);
                    });
                    
                    document.getElementById('slots-list').innerHTML = slotsHtml;
                    
                    // Re-add event listeners
                    setupEventListeners();
                    
                    // Update preview
                    selectSlot(Math.min(selectedIndex, saveSlots.length - 1));
                }
            });
        })();
    </script>
</body>
</html>`;
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
};
