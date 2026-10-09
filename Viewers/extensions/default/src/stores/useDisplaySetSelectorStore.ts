import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

/**
 * Identifier for the display set selector store type.
 */
const PRESENTATION_TYPE_ID = 'displaySetSelectorId';

/**
 * Flag to enable or disable debug mode for the store.
 * Set to `true` to enable zustand devtools.
 */
const DEBUG_STORE = false;

/**
 * State shape for the Display Set Selector store.
 */
type DisplaySetSelectorState = {
  /**
   * Type identifier for the store.
   */
  type: string;

  /**
   * Stores a mapping from `<activeStudyUID>:<displaySetSelectorId>:<matchOffset>` to `displaySetInstanceUID`.
   */
  displaySetSelectorMap: Record<string, string>;

  /**
   * Sets the display set selector for a given key.
   *
   * @param key - The key.
   * @param value - The `displaySetInstanceUID` to associate with the key.
   */
  setDisplaySetSelector: (key: string, value: string | null) => void;

  /**
   * Clears the entire display set selector map.
   */
  clearDisplaySetSelectorMap: () => void;
};

/**
 * Creates the Display Set Selector store.
 *
 * @param set - The zustand set function.
 * @returns The display set selector store state and actions.
 */
const createDisplaySetSelectorStore = (set): DisplaySetSelectorState => ({
  type: PRESENTATION_TYPE_ID,
  displaySetSelectorMap: {},

  /**
   * Sets the display set selector for a given key.
   */
  setDisplaySetSelector: (key: string, value: string | null) =>
    set(
      state => {
        const displaySetSelectorMap = { ...state.displaySetSelectorMap };
        // null means clear the override, not a display set for HP validation.
        if (value == null) delete displaySetSelectorMap[key];
        else displaySetSelectorMap[key] = value;
        return { displaySetSelectorMap };
      },
      false,
      'setDisplaySetSelector'
    ),

  /**
   * Clears the entire display set selector map.
   */
  clearDisplaySetSelectorMap: () =>
    set({ displaySetSelectorMap: {} }, false, 'clearDisplaySetSelectorMap'),
});

/**
 * Zustand store for managing display set selectors.
 * Applies devtools middleware when DEBUG_STORE is enabled.
 */
export const useDisplaySetSelectorStore = create<DisplaySetSelectorState>()(
  DEBUG_STORE
    ? devtools(createDisplaySetSelectorStore, { name: 'DisplaySetSelectorStore' })
    : createDisplaySetSelectorStore
);
