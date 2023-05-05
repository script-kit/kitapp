import { app, globalShortcut } from 'electron';
import log from 'electron-log';
import path from 'path';
import { readFile } from 'fs/promises';
import { subscribeKey } from 'valtio/utils';
import { debounce, throttle } from 'lodash';

import { mainScriptPath, shortcutsPath } from '@johnlindquist/kit/cjs/utils';

import { runPromptProcess } from './kit';
import { emitter, KitEvent } from './events';
import { focusPrompt, isFocused, isVisible, reload } from './prompt';
import { convertKey, kitState, subs } from './state';
import { Trigger } from './enums';
import { convertShortcut, shortcutInfo } from './helpers';
import { spawnShebang } from './process';

const registerFail = (shortcut: string, filePath: string) =>
  `# Shortcut Registration Failed

<code>${shortcut}</code> is already registered to ${path.basename(filePath)}
`;

const alreadyFail = (shortcut: string, filePath: string, otherPath = '') =>
  `# Shortcut Registration Failed

Attempting to assign <code>${shortcut}</code> to ${filePath}...

<code>${shortcut}</code> is already registered to ${path.basename(otherPath)}
`;

const mainFail = (shortcut: string, filePath: string) =>
  `# Failed to Register Main Shortcut

<code>${shortcut}</code> failed to register. May already be registered to another app.`;

const registerShortcut = (shortcut: string, filePath: string, shebang = '') => {
  try {
    const shortcutAction = throttle(
      async () => {
        kitState.shortcutPressed = shortcut;

        if (shebang) {
          // split shebang into command and args
          spawnShebang({ shebang, filePath });

          return;
        }

        runPromptProcess(filePath, [], {
          force: true,
          trigger: Trigger.Shortcut,
        });
        focusPrompt();
      },
      250,
      {
        leading: true,
      }
    );
    const success = globalShortcut.register(shortcut, shortcutAction);

    if (!success) {
      log.info(`Failed to register: ${shortcut} to ${filePath}`);
      shortcutInfo(shortcut, filePath, registerFail);
    } else {
      // log.info(`Registered: ${shortcut} to ${filePath}`);
    }

    return success;
  } catch (error) {
    return false;
  }
};

export const registerKillLatestShortcut = () => {
  const semicolon = convertKey(';');
  const killLatestShortcut = `CommandOrControl+Shift+${semicolon}`;
  const success = globalShortcut.register(killLatestShortcut, () => {
    kitState.shortcutPressed = killLatestShortcut;
    emitter.emit(KitEvent.RemoveMostRecent);
  });

  if (process.env.NODE_ENV === 'development') {
    globalShortcut.register(`Option+${semicolon}`, async () => {
      reload();
      // wait for reload to finish
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await runPromptProcess(mainScriptPath, [], {
        force: true,
        trigger: Trigger.Menu,
      });
    });
  }

  log.verbose(`Tray shortcut registered: ${success ? 'success' : 'fail'}`);
};

// const success = globalShortcut.register(``, async () => {
//   runPromptProcess(filePath);
//   focusPrompt();
// });

// if (!success) {
//   log.info(`Failed to register: ${shortcut} to ${filePath}`);
// }

// return success;

export const shortcutMap = new Map<
  string,
  {
    shortcut: string;
    shebang: string;
  }
>();

export const unlinkShortcuts = (filePath: string) => {
  const old = shortcutMap.get(filePath);

  if (old?.shortcut) {
    globalShortcut.unregister(old.shortcut);
    shortcutMap.delete(filePath);
  }
};

export const shortcutScriptChanged = ({
  filePath,
  shortcut,
  shebang,
  kenv,
}: {
  filePath: string;
  shortcut?: string;
  shebang?: string;
  kenv: string;
}) => {
  const convertedShortcut = convertShortcut(shortcut || '', filePath);
  const old = shortcutMap.get(filePath);
  // TODO: Bring back trusted kenvs
  // if (kenv !== '' && !kitState.trustedKenvs.includes(kenv)) {
  //   if (shortcut) {
  //     log.info(
  //       `Ignoring ${filePath} // Shortcut metadata because it's not trusted.`
  //     );
  //     log.info(
  //       `Add "KIT_TRUSTED_KENVS=${kenv}" to your .env file to trust it.`
  //     );
  //   }

  //   if (old) {
  //     globalShortcut.unregister(old.shortcut);
  //     shortcutMap.delete(filePath);
  //   }
  //   return;
  // }
  const sameScript = old?.shortcut === convertedShortcut;

  // Handle existing shortcuts

  const exists = [...shortcutMap.entries()].find(
    ([, s]) => s?.shortcut === convertedShortcut
  );
  if (exists && !sameScript) {
    log.info(
      `Shortcut ${convertedShortcut} already registered to ${exists[0]}`
    );
    shortcutInfo(convertedShortcut, filePath, alreadyFail, exists[0]);

    return;
  }

  if (old?.shortcut) {
    // No change
    if (sameScript) {
      const message = `${convertedShortcut} is already registered to ${filePath}`;
      log.info(message);

      return;
    }

    // User removed an existing shortcut
    globalShortcut.unregister(old.shortcut);
    shortcutMap.delete(filePath);
    log.info(`Unregistered ${old.shortcut} from ${filePath}`);
  }

  if (!convertedShortcut) {
    // log.info(`No shortcut found for ${filePath}`);
    return;
  }

  log.info(`Found shortcut: ${convertedShortcut} for ${filePath}`);
  // At this point, we know it's a new shortcut, so register it

  const registerSuccess = registerShortcut(
    convertedShortcut,
    filePath,
    shebang
  );

  if (registerSuccess && globalShortcut.isRegistered(convertedShortcut)) {
    log.info(`Registered ${convertedShortcut} to ${filePath}`);
    shortcutMap.set(filePath, {
      shortcut: convertedShortcut,
      shebang: shebang || '',
    });
  }
};

export const updateMainShortcut = async (filePath: string) => {
  log.info(`Updating main shortcut for ${filePath}`);
  if (filePath === shortcutsPath) {
    log.info(`SHORTCUTS DB CHANGED:`, filePath);
    const settings = JSON.parse(await readFile(filePath, 'utf-8'));
    const shortcut = settings?.shortcuts?.[mainScriptPath];

    const finalShortcut = convertShortcut(shortcut, filePath);
    if (!finalShortcut) return;

    log.verbose(`Converted main shortcut from ${shortcut} to ${finalShortcut}`);

    const old = shortcutMap.get(mainScriptPath);

    if (finalShortcut === old?.shortcut) return;

    if (old?.shortcut) {
      globalShortcut.unregister(old?.shortcut);
      shortcutMap.delete(mainScriptPath);
    }

    const mainShortcutAction = throttle(
      async () => {
        kitState.shortcutPressed = finalShortcut;
        log.info(`🏚  main shortcut`);
        if (isVisible() && !isFocused()) {
          focusPrompt();
          app.focus({
            steal: true,
          });
        } else {
          await runPromptProcess(mainScriptPath, [], {
            force: true,
            trigger: Trigger.Menu,
          });
        }
      },
      250,
      {
        leading: true,
      }
    );
    const ret = globalShortcut.register(finalShortcut, mainShortcutAction);

    if (!ret) {
      log.warn(`Failed to register: ${finalShortcut} to ${mainScriptPath}`);
      shortcutInfo(finalShortcut, mainScriptPath, mainFail);
    }

    if (ret && globalShortcut.isRegistered(finalShortcut)) {
      kitState.mainShortcut = finalShortcut;
      log.info(`Registered ${finalShortcut} to ${mainScriptPath}`);
      shortcutMap.set(mainScriptPath, {
        shortcut: finalShortcut,
        shebang: '',
      });
    }
  }
};

const pauseShortcuts = () => {
  log.info(`PAUSING GLOBAL SHORTCUTS`);
  globalShortcut.unregisterAll();
};

const resumeShortcuts = () => {
  log.info(`RESUMING GLOBAL SHORTCUTS`);
  shortcutMap.forEach(({ shortcut }, filePath) => {
    const convertedShortcut = convertShortcut(shortcut, filePath);
    log.info({
      filePath,
      shortcut,
      convertedShortcut,
    });
    registerShortcut(convertedShortcut, filePath);
  });
};

let paused = false;
const subShortcutsPaused = subscribeKey(
  kitState,
  'shortcutsPaused',
  (shortcutsPaused) => {
    if (paused === shortcutsPaused) return;
    paused = shortcutsPaused;
    if (shortcutsPaused) {
      pauseShortcuts();
    } else {
      resumeShortcuts();
    }
  }
);

subs.push(subShortcutsPaused);

// sub to keymap
let prevKeymap: any = null;

const subKeymap = subscribeKey(
  kitState,
  'keymap',
  debounce(async (keymap) => {
    log.info(`Handling keymap change...`);
    if (prevKeymap) {
      pauseShortcuts();
      await new Promise((resolve) => setTimeout(resolve, 200));
      resumeShortcuts();
    }

    prevKeymap = keymap;
  }, 200)
);

subs.push(subKeymap);