// WHAT: Curated emoji set for page icons — small enough to bundle, searchable
// by keyword. (A full emoji-picker dependency is overkill for a personal app.)
export const EMOJI: Array<[string, string]> = [
  ["📄", "page document"], ["📝", "note memo write"], ["📚", "books library"],
  ["📖", "book read"], ["📓", "notebook"], ["🗂️", "folder organize project"],
  ["📁", "folder"], ["🗃️", "archive files"], ["🗄️", "cabinet"],
  ["✅", "check done task"], ["☑️", "checkbox"], ["📋", "clipboard list"],
  ["📌", "pin"], ["📍", "location pin"], ["🔖", "bookmark"],
  ["🚀", "rocket launch ship"], ["⭐", "star favorite"], ["🌟", "glowing star"],
  ["✨", "sparkles new"], ["⚡", "zap lightning fast"], ["🔥", "fire hot"],
  ["💡", "idea lightbulb"], ["🧠", "brain mind ai"], ["🤖", "robot ai bot"],
  ["💻", "laptop computer code"], ["🖥️", "desktop computer"], ["⌨️", "keyboard"],
  ["🖱️", "mouse"], ["💾", "save disk"], ["🗜️", "compress"],
  ["⚙️", "gear settings"], ["🔧", "wrench tool fix"], ["🔨", "hammer build"],
  ["🛠️", "tools build"], ["🧰", "toolbox"], ["🔩", "bolt"],
  ["📦", "package box ship"], ["🏗️", "construction build"], ["🧪", "test lab experiment"],
  ["🔬", "microscope research"], ["🔭", "telescope explore"], ["🧬", "dna science"],
  ["📊", "chart bar data"], ["📈", "chart up growth"], ["📉", "chart down"],
  ["🗓️", "calendar date"], ["📅", "calendar"], ["⏰", "alarm clock time"],
  ["⏱️", "stopwatch timer"], ["⌛", "hourglass"], ["🕐", "clock"],
  ["🎯", "target goal dart"], ["🏆", "trophy win"], ["🥇", "medal first"],
  ["🎉", "party celebrate"], ["🎊", "confetti"], ["🎁", "gift"],
  ["💰", "money bag finance"], ["💵", "dollar cash"], ["💳", "credit card"],
  ["🧾", "receipt invoice"], ["🏦", "bank"], ["📧", "email mail"],
  ["✉️", "envelope mail"], ["📬", "mailbox inbox"], ["📣", "megaphone announce marketing"],
  ["📢", "loudspeaker"], ["💬", "chat message comment"], ["🗣️", "speak voice"],
  ["🎤", "microphone podcast record"], ["🎧", "headphones audio"], ["🎙️", "studio microphone podcast"],
  ["📷", "camera photo"], ["🎥", "video camera film"], ["🎬", "clapper video"],
  ["🖼️", "picture image art"], ["🎨", "art palette design"], ["✏️", "pencil edit draw"],
  ["🖊️", "pen write"], ["🖋️", "fountain pen"], ["📐", "ruler design"],
  ["🏠", "home house"], ["🏡", "house garden"], ["🏢", "office building work"],
  ["🏥", "hospital health"], ["🏋️", "gym workout fitness"], ["🧘", "yoga meditate"],
  ["❤️", "heart love health"], ["💪", "muscle strong"], ["🩺", "stethoscope doctor"],
  ["💊", "pill medicine"], ["🍎", "apple food"], ["🍕", "pizza food"],
  ["☕", "coffee"], ["🍳", "cooking recipe"], ["🛒", "shopping cart"],
  ["✈️", "airplane travel"], ["🗺️", "map travel"], ["🧳", "luggage trip"],
  ["🚗", "car drive"], ["🌍", "globe world earth"], ["🌐", "globe web internet"],
  ["☀️", "sun day"], ["🌙", "moon night"], ["🌈", "rainbow"],
  ["🌱", "seedling grow plant"], ["🌳", "tree nature"], ["🍀", "clover luck"],
  ["🐙", "octopus github"], ["🐍", "snake python"], ["🦀", "crab rust"],
  ["🕸️", "web spider"], ["🔒", "lock secure security"], ["🔑", "key access"],
  ["🛡️", "shield security defense"], ["🚨", "alarm alert urgent"], ["⚠️", "warning caution"],
  ["❓", "question help"], ["💼", "briefcase work job"], ["🎓", "graduation learn school"],
  ["🧑‍💻", "developer coder geek"], ["📡", "satellite signal server"], ["🖧", "network"],
  ["🗳️", "ballot vote politics"], ["📰", "newspaper news"], ["🪙", "coin crypto"],
  ["♟️", "chess strategy"], ["🎮", "game controller play"], ["🎲", "dice game random"],
  ["🧩", "puzzle piece plugin"], ["🪴", "potted plant"], ["🐾", "paws pets"],
];

export function searchEmoji(q: string): Array<[string, string]> {
  const s = q.trim().toLowerCase();
  if (!s) return EMOJI;
  return EMOJI.filter(([, name]) => name.includes(s));
}
