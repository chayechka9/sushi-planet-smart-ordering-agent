import type { MenuItemSnapshot } from "../../domain/order.js";

export interface NumberedTelegramMenuItem {
  number: number;
  item: MenuItemSnapshot;
}

/** Stable Telegram-only projection; order/cart calculations stay in core. */
export function numberAvailableTelegramMenuItems(
  menu: readonly MenuItemSnapshot[],
): NumberedTelegramMenuItem[] {
  return menu
    .filter((item) => item.available)
    .map((item) => ({ ...item }))
    .sort(compareMenuItemIds)
    .map((item, index) => ({ number: index + 1, item }));
}

function compareMenuItemIds(
  left: MenuItemSnapshot,
  right: MenuItemSnapshot,
): number {
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}
