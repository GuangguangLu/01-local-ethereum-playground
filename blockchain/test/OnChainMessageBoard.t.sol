// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {OnChainMessageBoard} from "../src/OnChainMessageBoard.sol";

contract OnChainMessageBoardTest {
    OnChainMessageBoard private board;

    constructor() {
        board = new OnChainMessageBoard();
    }

    function testConstructorStoresDefaultMessage() public view {
        require(board.messageCount() == 1, "expected one default message");

        (address author, string memory text, uint256 timestamp) = board.getMessage(0);
        require(author == address(this), "wrong default author");
        _requirePersonalIntroduction(text);
        require(timestamp > 0, "missing timestamp");
    }

    function testStoreAppendsWithoutChangingExistingMessage() public {
        (, string memory originalText,) = board.getMessage(0);

        board.store("My first permanent classroom message");

        require(board.messageCount() == 2, "message was not appended");
        (, string memory unchangedText,) = board.getMessage(0);
        (address author, string memory newText,) = board.getMessage(1);
        require(
            keccak256(bytes(originalText)) == keccak256(bytes(unchangedText)),
            "old message changed"
        );
        require(author == address(this), "wrong new-message author");
        require(
            keccak256(bytes(newText)) ==
                keccak256(bytes("My first permanent classroom message")),
            "wrong new-message text"
        );
    }

    function testRejectsEmptyMessage() public {
        (bool success,) = address(board).call(
            abi.encodeCall(OnChainMessageBoard.store, (""))
        );
        require(!success, "empty message should revert");
    }

    function testRejectsMessageOver280Bytes() public {
        string memory oversized = new string(281);
        (bool success,) = address(board).call(
            abi.encodeCall(OnChainMessageBoard.store, (oversized))
        );
        require(!success, "oversized message should revert");
    }

    function _requirePersonalIntroduction(string memory text) private pure {
        bytes memory actual = bytes(text);
        bytes memory prefix = bytes("Hello Web3, My name is \"");
        bytes memory suffix = bytes("\".");

        require(
            actual.length >= prefix.length + 1 + suffix.length,
            "student name is missing"
        );

        for (uint256 i = 0; i < prefix.length; i++) {
            require(actual[i] == prefix[i], "wrong introduction prefix");
        }

        require(
            actual[actual.length - 2] == suffix[0] &&
                actual[actual.length - 1] == suffix[1],
            "wrong introduction suffix"
        );
    }
}
