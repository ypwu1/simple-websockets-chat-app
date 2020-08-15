#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { ChatAppStack } from '../lib/chat-app-stack';

const app = new cdk.App();
const env = app.node.tryGetContext("env")
new ChatAppStack(app, `chat-app-${env}`);
