export type Guest = {
  id: string;
  name: string;
  tags: string[];
  partySize: number;
  childSeat?: boolean;
  note?: string;
  /** 所属派别（亲戚家 / 老同事圈等），存 group id */
  groupId?: string;
};

export type TableShape = 'round' | 'rect';

export type Table = {
  id: string;
  label: string;
  x: number;
  y: number;
  shape: TableShape;
  capacity: number;
  seatOrder: string[]; // guest ids, length <= capacity
};

export type RuleType = 'together' | 'apart' | 'adjacent' | 'separate';

/** 规则端点：宾客或派别。缺省视为宾客，兼容旧数据 */
export type RuleEndpointKind = 'guest' | 'group';

export type Rule = {
  id: string;
  type: RuleType;
  a: string; // guest id 或 group id
  b: string;
  aKind?: RuleEndpointKind;
  bKind?: RuleEndpointKind;
};

/**
 * 派别：一大家亲戚 / 一圈老同事。
 * keepTogether=true 表示这一家期望整家挤一桌，坐不下时提前报错。
 */
export type Group = {
  id: string;
  name: string;
  keepTogether: boolean;
};

export type Plan = {
  id: string;
  name: string;
  tables: Table[];
  guests: Guest[];
  rules: Rule[];
  groups: Group[];
  updatedAt: number;
};

export type Command =
  | { type: 'updatePlan'; plan: Plan }
  | { type: 'updateTables'; tables: Table[] }
  | { type: 'updateGuests'; guests: Guest[] }
  | { type: 'updateRules'; rules: Rule[] }
  | { type: 'updateGroups'; groups: Group[] }
  | { type: 'updateTable'; table: Table }
  | { type: 'addGuest'; guest: Guest }
  | { type: 'removeGuest'; guestId: string }
  | { type: 'addTable'; table: Table }
  | { type: 'removeTable'; tableId: string }
  | { type: 'moveGuest'; guestId: string; fromTableId: string | null; toTableId: string | null; toIndex?: number }
  | { type: 'autoSeat'; assignments: Record<string, string> }
  | { type: 'batch'; commands: Command[] };

export const TAG_OPTIONS = ['男方亲属', '女方亲属', '同事', '同学', '儿童', '素食'];
