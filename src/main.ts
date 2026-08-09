import { Session } from './core/session';
import { applyIcons } from './ui/icons';
import { CanvasHost } from './render/canvasHost';
import { Shell } from './ui/shell';
import { BoxesScene } from './scenes/boxesScene';
import { NumberLineScene } from './scenes/numberLineScene';
import { ConveyorScene } from './scenes/conveyorScene';
import { TapesScene } from './scenes/tapesScene';
import { ScalesScene } from './scenes/scalesScene';
import { loadLesson } from './lessons/lesson';
import { PRESETS } from './lessons/presets';

applyIcons(document);

const canvas = document.getElementById('stage') as HTMLCanvasElement;

const session = new Session();
const host = new CanvasHost(canvas);
const scenes = [new BoxesScene(), new NumberLineScene(), new ConveyorScene(), new TapesScene(), new ScalesScene()];

new Shell(session, host, scenes, PRESETS);

loadLesson(session, PRESETS[0]!);
