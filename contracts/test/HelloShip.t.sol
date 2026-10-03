// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {HelloShip} from "../src/HelloShip.sol";
contract HelloShipTest { function testMessage() public { HelloShip hello = new HelloShip(); require(keccak256(bytes(hello.message())) == keccak256(bytes("ship.fun environment ready")), "unexpected message"); } }
