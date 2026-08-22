import * as ff from '@google-cloud/functions-framework';
import { Storage } from '@google-cloud/storage';
import { createApp, type BucketLike } from './handlers';

const bucketName = process.env.WORLDS_BUCKET ?? 'minicraft-worlds';
const bucket = new Storage().bucket(bucketName) as unknown as BucketLike;

ff.http('minicraftApi', createApp(bucket));
