// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract MachinaCountdown1155 is ERC1155, Ownable {
    uint8 public constant TOTAL_DAYS = 40;

    uint64 public immutable startTime;
    bool public immutable testMode;

    uint8 public testDay;

    mapping(address => uint256) public claimedBitmap;
    mapping(address => uint8) public claimedCount;

    event DailyClaim(address indexed wallet, uint8 indexed day, uint256 indexed tokenId);
    event TestDayChanged(uint8 indexed day);
    event SmokeDayReset(address indexed wallet, uint8 indexed day);

    constructor(
        string memory metadataUri,
        uint64 campaignStartTime,
        bool enableTestMode
    ) ERC1155(metadataUri) Ownable(msg.sender) {
        startTime = campaignStartTime;
        testMode = enableTestMode;
    }

    function currentDay() public view returns (uint8) {
        if (testMode && testDay != 0) {
            return testDay;
        }

        if (block.timestamp < startTime) {
            return 0;
        }

        uint256 elapsedDays = (block.timestamp - startTime) / 1 days;
        if (elapsedDays >= TOTAL_DAYS) {
            return TOTAL_DAYS + 1;
        }

        return uint8(elapsedDays + 1);
    }

    function hasClaimed(address wallet, uint8 day) public view returns (bool) {
        if (day == 0 || day > TOTAL_DAYS) {
            return false;
        }

        uint256 bit = uint256(1) << (day - 1);
        return (claimedBitmap[wallet] & bit) != 0;
    }

    function claim() external {
        uint8 day = currentDay();
        require(day >= 1 && day <= TOTAL_DAYS, "Claim window closed");
        require(!hasClaimed(msg.sender, day), "Already claimed");

        uint256 bit = uint256(1) << (day - 1);
        claimedBitmap[msg.sender] |= bit;
        claimedCount[msg.sender] += 1;

        _mint(msg.sender, uint256(day), 1, "");
        emit DailyClaim(msg.sender, day, uint256(day));
    }

    function eligibilityTier(address wallet) external view returns (uint8) {
        uint8 count = claimedCount[wallet];
        if (count >= 40) return 40;
        if (count >= 30) return 30;
        if (count >= 20) return 20;
        return 0;
    }

    function claimedDays(address wallet) external view returns (uint8[] memory days) {
        uint8 count = claimedCount[wallet];
        days = new uint8[](count);

        uint256 cursor;
        for (uint8 day = 1; day <= TOTAL_DAYS; day++) {
            if (hasClaimed(wallet, day)) {
                days[cursor] = day;
                cursor++;
            }
        }
    }

    function setTestDay(uint8 day) external onlyOwner {
        require(testMode, "Test mode disabled");
        require(day >= 1 && day <= TOTAL_DAYS, "Invalid day");
        testDay = day;
        emit TestDayChanged(day);
    }

    function resetSmokeDay(address wallet, uint8 day) external onlyOwner {
        require(testMode, "Test mode disabled");
        require(day >= 1 && day <= TOTAL_DAYS, "Invalid day");
        require(hasClaimed(wallet, day), "Day not claimed");

        uint256 bit = uint256(1) << (day - 1);
        claimedBitmap[wallet] &= ~bit;
        claimedCount[wallet] -= 1;

        if (balanceOf(wallet, uint256(day)) > 0) {
            _burn(wallet, uint256(day), 1);
        }

        emit SmokeDayReset(wallet, day);
    }

    function setMetadataUri(string calldata newUri) external onlyOwner {
        _setURI(newUri);
    }
}
