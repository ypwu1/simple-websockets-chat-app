import * as cdk from '@aws-cdk/core';
import {ConcreteDependable, Duration, RemovalPolicy} from '@aws-cdk/core';
import * as iam from '@aws-cdk/aws-iam';
import {Effect} from '@aws-cdk/aws-iam';
import {CfnApi, CfnDeployment, CfnIntegration, CfnRoute, CfnStage} from "@aws-cdk/aws-apigatewayv2";
import {AssetCode, Function, Runtime} from "@aws-cdk/aws-lambda";
import * as dyn from "@aws-cdk/aws-dynamodb";
import {AttributeType} from "@aws-cdk/aws-dynamodb";

import configJson from '../config.json';


export class ChatAppStack extends cdk.Stack {
    constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);
        const config = (configJson as any)[this.node.tryGetContext("env")];
        let tableName:string = this.node.tryGetContext("tableName")
        if (!tableName) {
            tableName = "simplechat_connections";
        }
        // initialise api
        const name = "chat-api"
        const api = new CfnApi(this, name, {
            name: "ChatAppApi",
            protocolType: "WEBSOCKET",
            routeSelectionExpression: "$request.body.action",
        });
        const table = new dyn.Table(this, `${name}-table`, {
            tableName: tableName,
            partitionKey: {
                name: "connectionId",
                type: AttributeType.STRING,
            },
            readCapacity: 5,
            writeCapacity: 5,
            removalPolicy: RemovalPolicy.DESTROY
        });

        // initialise lambda and permissions

        const lambdaPolicy = new iam.PolicyStatement({
            actions: [
                "dynamodb:GetItem",
                "dynamodb:DeleteItem",
                "dynamodb:PutItem",
                "dynamodb:Scan",
                "dynamodb:Query",
                "dynamodb:UpdateItem",
                "dynamodb:BatchWriteItem",
                "dynamodb:BatchGetItem",
                "dynamodb:DescribeTable",
                "dynamodb:ConditionCheckItem"
            ],
            resources: [table.tableArn]
        });

        const connectLambdaRole = new iam.Role(this, "connectLambdaRole", {
            assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com")
        })
        connectLambdaRole.addToPolicy(lambdaPolicy)
        connectLambdaRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"));

        const disconnectLambdaRole = new iam.Role(this, "disconnectLambdaRole", {
            assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com")
        })
        disconnectLambdaRole.addToPolicy(lambdaPolicy)
        disconnectLambdaRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"));

        const messageLambdaRole = new iam.Role(this, "messageLambdaRole", {
            assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com")
        })
        messageLambdaRole.addToPolicy(lambdaPolicy)
        messageLambdaRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"));

        const connectFunc = new Function(this, 'connect-lambda', {
            code: new AssetCode('../onconnect'),
            handler: 'app.handler',
            runtime: Runtime.NODEJS_12_X,
            timeout: Duration.seconds(300),
            memorySize: 256,
            role: connectLambdaRole,
            environment: {
                "TABLE_NAME": tableName,
            }
        });

        const disconnectFunc = new Function(this, 'disconnect-lambda', {
            code: new AssetCode('../ondisconnect'),
            handler: 'app.handler',
            runtime: Runtime.NODEJS_12_X,
            timeout: Duration.seconds(300),
            memorySize: 256,
            role: disconnectLambdaRole,
            environment: {
                "TABLE_NAME": tableName,
            }
        });

        const messageFunc = new Function(this, 'message-lambda', {
            code: new AssetCode('../sendmessage'),
            handler: 'app.handler',
            runtime: Runtime.NODEJS_12_X,
            timeout: Duration.seconds(300),
            memorySize: 256,
            role: messageLambdaRole,
            initialPolicy: [
                new iam.PolicyStatement({
                    actions: [
                        'execute-api:ManageConnections'
                    ],
                    resources: [
                        "arn:aws:execute-api:" + config["region"] + ":" + config["account_id"] + ":" + api.ref + "/*"
                    ],
                    effect: Effect.ALLOW,
                })
            ],
            environment: {
                "TABLE_NAME": tableName,
            }
        });

        // access role for the socket api to access the socket lambda
        const policy = new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            resources: [
                connectFunc.functionArn,
                disconnectFunc.functionArn,
                messageFunc.functionArn
            ],
            actions: ["lambda:InvokeFunction"]
        });

        const role = new iam.Role(this, `${name}-iam-role`, {
            assumedBy: new iam.ServicePrincipal("apigateway.amazonaws.com")
        });
        role.addToPolicy(policy);

        // lambda integration
        const connectIntegration = new CfnIntegration(this, "connect-lambda-integration", {
            apiId: api.ref,
            integrationType: "AWS_PROXY",
            integrationUri: "arn:aws:apigateway:" + config["region"] + ":lambda:path/2015-03-31/functions/" + connectFunc.functionArn + "/invocations",
            credentialsArn: role.roleArn,
        })
        const disconnectIntegration = new CfnIntegration(this, "disconnect-lambda-integration", {
            apiId: api.ref,
            integrationType: "AWS_PROXY",
            integrationUri: "arn:aws:apigateway:" + config["region"] + ":lambda:path/2015-03-31/functions/" + disconnectFunc.functionArn + "/invocations",
            credentialsArn: role.roleArn
        })
        const messageIntegration = new CfnIntegration(this, "message-lambda-integration", {
            apiId: api.ref,
            integrationType: "AWS_PROXY",
            integrationUri: "arn:aws:apigateway:" + config["region"] + ":lambda:path/2015-03-31/functions/" + messageFunc.functionArn + "/invocations",
            credentialsArn: role.roleArn
        })

        const connectRoute = new CfnRoute(this, "connect-route", {
            apiId: api.ref,
            routeKey: "$connect",
            authorizationType: "NONE",
            target: "integrations/" + connectIntegration.ref,
        });

        const disconnectRoute = new CfnRoute(this, "disconnect-route", {
            apiId: api.ref,
            routeKey: "$disconnect",
            authorizationType: "NONE",
            target: "integrations/" + disconnectIntegration.ref,
        });

        const messageRoute = new CfnRoute(this, "message-route", {
            apiId: api.ref,
            routeKey: "sendmessage",
            authorizationType: "NONE",
            target: "integrations/" + messageIntegration.ref,
        });

        const deployment = new CfnDeployment(this, `${name}-deployment`, {
            apiId: api.ref
        });

        const stage = new CfnStage(this, `${name}-stage`, {
            apiId: api.ref,
            autoDeploy: true,
            deploymentId: deployment.ref,
            stageName: "dev"
        });

        const dependencies = new ConcreteDependable();
        dependencies.add(connectRoute)
        dependencies.add(disconnectRoute)
        dependencies.add(messageRoute)
        deployment.node.addDependency(dependencies);
    }
}
