const adjectives = ['Shadow', 'Blood', 'Dark', 'Night', 'Frost', 'Doom', 'Iron', 'Steel', 'Rage', 'Grim', 'Hollow', 'Void', 'Ash', 'Cinder', 'Storm', 'Thunder'];
const nouns = ['Hound', 'Reaper', 'Wraith', 'Titan', 'Knight', 'Wolf', 'Raven', 'Ripper', 'Scourge', 'Viper', 'Slayer', 'Demon', 'Ghost', 'Phantom', 'Warden'];

const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
const noun = nouns[Math.floor(Math.random() * nouns.length)];
const num = Math.floor(Math.random() * 1000);

console.log(`${adj}${noun}${num}`);