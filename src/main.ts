import { Session } from './core/session';
import { applyIcons } from './ui/icons';
import { CanvasHost } from './render/canvasHost';
import { Shell } from './ui/shell';
import { BoxesScene } from './scenes/boxesScene';
import { NumberLineScene } from './scenes/numberLineScene';
import { PlaneScene } from './scenes/planeScene';
import { SpaceScene } from './scenes/spaceScene';
import { StatsScene } from './scenes/statsScene';
import { CircleScene } from './scenes/circleScene';
import { ConveyorScene } from './scenes/conveyorScene';
import { TapesScene } from './scenes/tapesScene';
import { ScalesScene } from './scenes/scalesScene';
import { AreaScene } from './scenes/areaScene';
import { loadLesson } from './lessons/lesson';
import { PRESETS } from './lessons/presets';

applyIcons(document);

const canvas = document.getElementById('stage') as HTMLCanvasElement;

const session = new Session();
const host = new CanvasHost(canvas);
const scenes = [new BoxesScene(), new NumberLineScene(), new PlaneScene(), new ConveyorScene(), new TapesScene(), new AreaScene(), new SpaceScene(), new StatsScene(), new CircleScene(), new ScalesScene()];

new Shell(session, host, scenes);

loadLesson(session, PRESETS[0]!);
