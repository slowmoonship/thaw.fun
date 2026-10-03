// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {HelloShip} from "../src/HelloShip.sol";
contract DeployHelloShip { function deploy() external returns (HelloShip) { return new HelloShip(); } }
