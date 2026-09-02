import * as vscode from 'vscode';
import { ObjectSpyPanel, OBJECT_SPY_VIEW_ID } from './panel/objectSpyPanel';
import { SettingsStore } from './settings/settingsStore';

export function activate(context: vscode.ExtensionContext): void {
  const settingsStore = new SettingsStore(context);
  const panelManager = new ObjectSpyPanel(context, settingsStore);

  context.subscriptions.push(
    // Registers softPlay's main UI as an Activity Bar sidebar view (see
    // package.json's viewsContainers/views) rather than only a floating
    // editor-tab panel reachable via the Command Palette.
    vscode.window.registerWebviewViewProvider(OBJECT_SPY_VIEW_ID, panelManager, {
      webviewOptions: { retainContextWhenHidden: true }
    }),

    vscode.commands.registerCommand('objectSpy.openPanel', () => {
      panelManager.show();
    }),

    vscode.commands.registerCommand('objectSpy.start', async () => {
      panelManager.show();
      await panelManager.startBrowser();
    }),

    vscode.commands.registerCommand('objectSpy.stop', async () => {
      await panelManager.stopBrowser();
    }),

    vscode.commands.registerCommand('objectSpy.openSettings', () => {
      panelManager.openSettings();
    }),

    // Ensures CodegenManager (and any launched codegen process handle) is
    // cleaned up when the extension host shuts down.
    { dispose: () => panelManager.dispose() },
    settingsStore
  );
}

export function deactivate(): void {
  // Cleanup is handled via the disposable registered in activate().
}
